import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

import { getCurrentModelDownloadStatus } from "./modelDownloadManager";
import { transcribeAudioLocal } from "./localWhisper";
import { devTiming, logDuration, nowMs } from "./perf";
import { isConcurrentTier1Enabled, loadTier1Config } from "./tier1Config";
import type { ProcessingJob } from "./processingJob";
import type { WhisperModelId } from "./whisperModels";
import { showToast } from "../../components/Toast";

export type ASRTier = "native" | "whisper";

export type ASRTranscriptionResult = {
  transcript: string;
  tier: ASRTier;
  /** Which local Whisper engine produced this transcript — unset when
   * `tier` is "native" (no local model involved) or nothing was captured. */
  whisperModelId?: WhisperModelId;
};

/**
 * Android's SpeechRecognizer and the raw PCM capture in services/audio/recorder.ts
 * are two independent audio-input sessions. Whether a device tolerates both
 * holding the mic at once is device/OEM-dependent — there's no reliable way
 * to know without running it. Rather than choose one exclusively (which would
 * mean losing either note playback audio or the accuracy/speed benefit of
 * on-device native recognition), this router starts the native session
 * *alongside* the existing PCM recorder and simply falls back to Whisper on
 * the already-recorded WAV file if the native session errors out, times out,
 * or the recognizer produces nothing. Every code path below is written to
 * fail into Tier 2, never to fail closed — a note is never lost because Tier
 * 1 didn't cooperate on a given device.
 */
let nativeAvailability: boolean | null = null;

function checkNativeTierAvailable(): boolean {
  if (nativeAvailability !== null) {
    return nativeAvailability;
  }
  try {
    // requiresOnDeviceRecognition below is the whole point of gating on
    // supportsOnDeviceRecognition() here too — this project's core loop
    // (see CLAUDE.md) must never silently depend on a network call. If a
    // device can only do network-backed recognition, Tier 1 is treated as
    // unavailable and every note falls through to local Whisper instead.
    nativeAvailability =
      ExpoSpeechRecognitionModule.isRecognitionAvailable() &&
      ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
  } catch (err) {
    console.warn("[ASRRouter] Native availability check failed, defaulting to Tier 2", err);
    nativeAvailability = false;
  }
  return nativeAvailability;
}

/** Waits for a stopped recognizer's own terminal "end", then aborts. */
export const TIER1_STOP_TIMEOUT_MS = 1500;
/** Waits for an aborted recognizer's terminal "end". */
export const TIER1_ABORT_TIMEOUT_MS = 1000;

void loadTier1Config();

/**
 * One recognition session (Gate B: its own lifecycle, separate from the PCM
 * microphone session). Terminal = the library's "end", which it emits after
 * cancelling and destroying the recognizer on every path (stop, abort,
 * error). "end" carries no session identity, so only one session may await
 * it at a time, and every wait is bounded: a recognizer that never reports
 * "end" marks Tier 1 unconfirmed and later recordings skip it (Whisper
 * always transcribes the PCM recording) until a stray "end" arrives.
 */
class NativeASRSession {
  finalTranscript = "";
  ended = false;
  /** False once cancelled: its transcript is never used. */
  useTranscript = true;
  private waiters: Array<() => void> = [];

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  waitForEnd(timeoutMs: number): Promise<boolean> {
    if (this.ended) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.ended), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** The session that hasn't reported "end" yet (listening, stopping or
 * aborting) — the only one recognizer events can belong to. */
let current: NativeASRSession | null = null;
/** A recognizer ended without "end" inside the bounds: Tier 1 is skipped
 * until a stray "end" shows the old one has finished. */
let recognizerUnconfirmed = false;
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  ExpoSpeechRecognitionModule.addListener("result", (event) => {
    const transcript = event.results?.[0]?.transcript;
    if (transcript && current && !current.ended && current.useTranscript) {
      current.finalTranscript = transcript;
    }
  });
  ExpoSpeechRecognitionModule.addListener("end", () => {
    if (current && !current.ended) {
      current.finish();
      return;
    }
    // Nobody waiting: a late "end" from a recognizer we stopped waiting for.
    if (recognizerUnconfirmed) devTiming("ASRRouter", "tier1 stray end absorbed");
    recognizerUnconfirmed = false;
  });
  ExpoSpeechRecognitionModule.addListener("error", (event) => {
    // Informational: the library follows every error (and an abort's own
    // "aborted") with its terminal "end".
    if (event.error !== "aborted") {
      console.warn("[ASRRouter] Tier 1 (native) error, will fall back to Tier 2:", event.error, event.message);
    }
  });
}

/** Ends `session` (stop or abort), bounded; forgets it either way. */
async function terminate(session: NativeASRSession, how: "stop" | "abort"): Promise<void> {
  const requestedAt = nowMs();
  let ended = false;
  if (how === "stop") {
    try {
      ExpoSpeechRecognitionModule.stop();
      ended = await session.waitForEnd(TIER1_STOP_TIMEOUT_MS);
    } catch (err) {
      console.warn("[ASRRouter] Tier 1 stop() threw, falling back to Tier 2", err);
    }
  }
  if (!ended) {
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch (err) {
      console.warn("[ASRRouter] Tier 1 abort() threw", err);
    }
    ended = await session.waitForEnd(TIER1_ABORT_TIMEOUT_MS);
  }
  devTiming("ASRRouter", ended ? "tier1 ended" : "tier1 end not confirmed", {
    how,
    ms: Math.round(nowMs() - requestedAt),
  });
  if (!ended) recognizerUnconfirmed = true;
  if (current === session) current = null;
}

/**
 * Call when recording starts. Opportunistically starts Tier 1 (on-device
 * native SpeechRecognizer) in the background — never throws, since the
 * caller's own PCM recorder (services/audio/recorder.ts) is the real source
 * of truth for the note's audio and always keeps running regardless.
 * Skipped when Xayra Test has switched it off, while an earlier recognizer
 * is still ending, or after one never confirmed its end.
 */
export function startListening(): void {
  if (!checkNativeTierAvailable()) return;
  if (!isConcurrentTier1Enabled()) {
    devTiming("ASRRouter", "tier1 skipped", { reason: "disabled" });
    return;
  }
  if (current || recognizerUnconfirmed) {
    devTiming("ASRRouter", "tier1 skipped", { reason: current ? "previous still ending" : "previous unconfirmed" });
    return;
  }
  ensureSubscribed();
  const session = new NativeASRSession();
  current = session;
  try {
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: false,
      requiresOnDeviceRecognition: true,
    });
    devTiming("ASRRouter", "tier1 started");
  } catch (err) {
    console.warn("[ASRRouter] Tier 1 failed to start, will use Tier 2 on stop", err);
    current = null;
  }
}

/**
 * Build 42 P2-5 fix (qa/05-consolidated-triage.md P2-5): shown at most once
 * per app session — nothing here coordinates the download's I/O with
 * Whisper's own CPU-bound inference (a genuinely hard fix given the actual
 * data transfer happens inside Android's own DownloadManager service,
 * outside this app's process/CPU budget entirely), so this closes the
 * "silent, unexplained slowness" gap the same way the honest-warning
 * approach already does elsewhere in this app, rather than attempting a
 * throttling mechanism this app doesn't actually have the power to enforce.
 */
/** A cancelled recording: the native recognizer started alongside it is
 * aborted and its transcript is never used. A no-op when nothing is
 * listening. */
export function cancelListening(): void {
  const session = current;
  if (!session || !session.useTranscript) return;
  session.useTranscript = false;
  void terminate(session, "abort");
}

let hasWarnedAboutDownloadContention = false;

/**
 * Call when recording stops, passing the already-finalized WAV file uri
 * (or null if none was captured). Prefers the Tier 1 transcript if the
 * native session produced one; otherwise runs local Whisper on the WAV file.
 */
export async function transcribe(audioUri: string | null, job?: ProcessingJob): Promise<ASRTranscriptionResult> {
  if (!hasWarnedAboutDownloadContention && getCurrentModelDownloadStatus().status === "downloading") {
    hasWarnedAboutDownloadContention = true;
    showToast("Setup is still finishing in the background — transcription may be a bit slower than usual");
  }

  const session = current;
  if (session && session.useTranscript) {
    session.useTranscript = false;
    const start = nowMs();
    await terminate(session, "stop");
    const transcript = session.finalTranscript.trim();
    if (transcript) {
      logDuration("[ASRRouter] Tier 1 (native, on-device) transcription", start);
      console.log("[ASRRouter] Used Tier 1: native on-device SpeechRecognizer");
      return { transcript, tier: "native" };
    }
    console.warn("[ASRRouter] Tier 1 produced no transcript, falling back to Tier 2 (Whisper)");
  }

  if (!audioUri) {
    return { transcript: "", tier: "whisper" };
  }
  const start = nowMs();
  const { transcript, modelId } = await transcribeAudioLocal(audioUri, job);
  logDuration("[ASRRouter] Tier 2 (local Whisper) transcription", start);
  console.log(`[ASRRouter] Used Tier 2: local Whisper (${modelId})`);
  return { transcript, tier: "whisper", whisperModelId: modelId };
}

export const asrRouter = { startListening, cancelListening, transcribe };
