import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

import { getCurrentModelDownloadStatus } from "./modelDownloadManager";
import { transcribeAudioLocal } from "./localWhisper";
import { logDuration, nowMs } from "./perf";
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

class NativeASRSession {
  private finalTranscript = "";
  private ended = false;
  private endWaiters: Array<() => void> = [];
  private subscriptions: Array<{ remove: () => void }> = [];

  constructor() {
    this.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("result", (event) => {
        const transcript = event.results?.[0]?.transcript;
        if (transcript) {
          this.finalTranscript = transcript;
        }
      }),
      ExpoSpeechRecognitionModule.addListener("end", () => this.finish()),
      ExpoSpeechRecognitionModule.addListener("error", (event) => {
        console.warn("[ASRRouter] Tier 1 (native) error, will fall back to Tier 2:", event.error, event.message);
        this.finish();
      })
    );
  }

  private finish(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endWaiters.forEach((resolve) => resolve());
    this.endWaiters = [];
  }

  private waitForEnd(): Promise<void> {
    if (this.ended) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.endWaiters.push(resolve));
  }

  start(): void {
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: false,
      requiresOnDeviceRecognition: true,
    });
  }

  /** Stops the session and resolves once the native side has confirmed
   * `end` (or `error`) — never rejects, since a Tier 1 failure is always a
   * signal to fall back, not a hard error for the caller. */
  async stop(): Promise<string> {
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch (err) {
      console.warn("[ASRRouter] Tier 1 stop() threw, falling back to Tier 2", err);
      this.finish();
    }
    await this.waitForEnd();
    this.subscriptions.forEach((sub) => sub.remove());
    return this.finalTranscript.trim();
  }
}

let activeSession: NativeASRSession | null = null;
let sessionIsNative = false;

/**
 * Call when recording starts. Opportunistically starts Tier 1 (on-device
 * native SpeechRecognizer) in the background — never throws, since the
 * caller's own PCM recorder (services/audio/recorder.ts) is the real source
 * of truth for the note's audio and always keeps running regardless.
 */
export function startListening(): void {
  sessionIsNative = checkNativeTierAvailable();
  if (!sessionIsNative) {
    activeSession = null;
    return;
  }
  activeSession = new NativeASRSession();
  try {
    activeSession.start();
  } catch (err) {
    console.warn("[ASRRouter] Tier 1 failed to start, will use Tier 2 on stop", err);
    activeSession = null;
    sessionIsNative = false;
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
let hasWarnedAboutDownloadContention = false;

/**
 * Call when recording stops, passing the already-finalized WAV file uri
 * (or null if none was captured). Prefers the Tier 1 transcript if the
 * native session produced one; otherwise runs local Whisper on the WAV file.
 */
export async function transcribe(audioUri: string | null): Promise<ASRTranscriptionResult> {
  if (!hasWarnedAboutDownloadContention && getCurrentModelDownloadStatus().status === "downloading") {
    hasWarnedAboutDownloadContention = true;
    showToast("Setup is still finishing in the background — transcription may be a bit slower than usual");
  }

  if (sessionIsNative && activeSession) {
    const session = activeSession;
    activeSession = null;
    sessionIsNative = false;
    const start = nowMs();
    const transcript = await session.stop();
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
  const { transcript, modelId } = await transcribeAudioLocal(audioUri);
  logDuration("[ASRRouter] Tier 2 (local Whisper) transcription", start);
  console.log(`[ASRRouter] Used Tier 2: local Whisper (${modelId})`);
  return { transcript, tier: "whisper", whisperModelId: modelId };
}

export const asrRouter = { startListening, transcribe };
