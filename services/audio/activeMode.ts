import { useCallback, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import AudioRecord from "@fugood/react-native-audio-pcm-stream";

import { BITS_PER_SAMPLE, CHANNELS, SAMPLE_RATE, computeRms, writePcmChunksAsWav } from "./wav";

export type ActiveModeState = "idle" | "listening" | "processing" | "speaking";

/**
 * `reportState` lets the caller (Notes/Chat screen) tell the manager when
 * it's moved from "transcribing/acting" into "speaking the result" —
 * ActiveModeManager itself only knows "an utterance finished, I handed it
 * off," not what the caller is doing with it at any given moment.
 */
export type ActiveModeUtteranceHandler = (
  audioUri: string,
  reportState: (state: "processing" | "speaking") => void
) => Promise<void>;

export type ActiveModeCallbacks = {
  onUtterance: ActiveModeUtteranceHandler;
  onStateChange?: (state: ActiveModeState) => void;
  onError?: (error: unknown) => void;
};

/**
 * Simple energy-threshold VAD: distinguishes "someone is talking" from
 * "quiet room" by raw loudness alone. This is a real, known limitation —
 * it cannot distinguish a loud voice from loud *non-voice* noise (running
 * shower water, in particular, is close to continuous white noise loud
 * enough to sit above almost any reasonable threshold). It works well
 * hands-free in an ordinarily quiet room; a genuinely shower-safe VAD would
 * need spectral/energy-in-speech-band analysis or a real ML VAD model,
 * neither of which is implemented here. Documented rather than silently
 * pretended away — see PROJECT_STATE_HANDOFF.md.
 *
 * ADAPTIVE THRESHOLD (was a single fixed constant): confirmed on-device that
 * a fixed 0.02 RMS floor requires the phone to be within roughly arm's
 * length — speech from 2-3 meters away simply never crosses it, so
 * `hasDetectedSpeech` never flips true and `finalizeUtterance` silently
 * discards the whole recording as "nothing said" before Whisper ever runs
 * (see the `!hadSpeech` branch below). Root cause: mic input power falls off
 * sharply with distance, and one fixed threshold can't be right for both a
 * close, quiet room and a far, still-quiet room.
 *
 * Fix: each listen cycle (`armListening`) samples the room's own ambient
 * noise floor for `NOISE_FLOOR_CALIBRATION_MS` before evaluating speech at
 * all, then sets that cycle's actual threshold to
 * `noiseFloor * SPEECH_ABOVE_FLOOR_MULTIPLIER`, clamped to
 * [`MIN_SPEECH_RMS_THRESHOLD`, `MAX_SPEECH_RMS_THRESHOLD`]. The upper clamp
 * is the OLD fixed value — a loud room can never end up needing a louder
 * trigger than before, only a quiet one can end up needing a much quieter
 * (i.e. farther-away-friendly) one. This is still raw-energy VAD, not a real
 * ML model — it still can't tell a distant quiet voice from distant quiet
 * non-voice noise any better than before; it can now hear a distant quiet
 * ANYTHING that's clearly above that room's own silence, which a fixed
 * threshold tuned for "close to the mic" could not.
 */
const MIN_SPEECH_RMS_THRESHOLD = 0.006;
const MAX_SPEECH_RMS_THRESHOLD = 0.02;
const SPEECH_ABOVE_FLOOR_MULTIPLIER = 2.5;
/** How long each listen cycle spends sampling ambient noise before it starts
 * evaluating those samples as speech/silence. Short enough that a user who
 * starts talking immediately after the wake gesture only loses a fraction of
 * a word to mis-calibration (worst case: that fraction gets folded into the
 * noise floor, nudging the threshold up slightly for the rest of THIS
 * utterance only — the next armListening() cycle recalibrates from zero). */
const NOISE_FLOOR_CALIBRATION_MS = 300;
const SILENCE_HOLD_MS = 1500;
/** Guards against a stray tap/cough finalizing a near-empty "utterance". */
const MIN_UTTERANCE_MS = 400;
/** Safety cap so a miscalibrated threshold (e.g. loud background noise never
 * dropping below that cycle's calibrated `speechRmsThreshold`) can't record
 * indefinitely. */
const MAX_UTTERANCE_MS = 60_000;
const SILENCE_POLL_INTERVAL_MS = 200;

const KEEP_AWAKE_TAG = "remi-active-mode";

/**
 * Build 24 REFACTOR HANDSFREE WAKE-WORD DETECTION ENGINE — read this before
 * assuming more than what's actually here. This is explicitly NOT an
 * acoustic wake-word engine, still. A real one (Porcupine or similar) listens
 * to raw audio frames continuously and recognizes the acoustic pattern of a
 * specific phrase BEFORE any recording/transcription happens at all — that
 * needs a native module, an external Picovoice AccessKey, and a
 * custom-trained "Hey Xayra" model file, none of which exist in this project
 * and none of which are obtainable from inside this session (there's no
 * account to generate an AccessKey with, and a custom wake-word model has to
 * be trained via Picovoice's own console, not synthesized locally). Silently
 * pretending otherwise would misrepresent what changed here — see this same
 * honesty pattern re-stated on `useActiveMode` below and in every build back
 * to 17.
 *
 * What THIS actually is: a local, post-transcription phrase-matching filter
 * — the achievable half of the task's own "keyword spotter ... or local
 * phrase matching" alternative. The RMS-threshold VAD above still can't tell
 * "someone is talking" from "loud ambient noise" at the AUDIO level (that
 * limitation is unchanged and undiminished); this instead asks, once
 * Whisper has already produced a transcript, whether the RESULT actually
 * mentions the wake word. Manual recordings (the center button) never go
 * through this filter: a deliberately short manual note ("Buy milk") is a
 * real, wanted 2-word note, not noise — this gate only applies when nobody
 * physically pressed record for it.
 *
 * Build 25 STRICT DUAL-MODE WAKE-WORD GATEKEEPER — supersedes Build 24's
 * leniency. Build 24's version (`isLikelyAmbientNoise`, since removed) let
 * ANY transcript of three or more words through even without ever saying
 * "Xayra" — a bare "Any notes today?" was accepted as deliberate speech.
 * Build 25 tightens that: EVERY Handsfree utterance, in both Record and Ask
 * mode, must contain something recognizable as the wake word or it's
 * discarded before it ever reaches SQLite (Record) or the RAG pipeline
 * (Ask) — see app/index.tsx's `finishUtterance`. `WAKE_WORD_GATE_PATTERN`
 * also recognizes a handful of phonetically-close near-misses ("Zaira",
 * "Cyra", "Zyra", "Exayra") the on-device Whisper model has been observed to
 * mishear "Xayra" as — still purely a post-transcription text match, not an
 * acoustic wake-word engine (see the long comment above; that gap is
 * unchanged). There is no more word-count leniency: a two-word "Xayra, stop"
 * still passes (it contains the word), but a wake-word-free "Any notes
 * today?" no longer does, regardless of length. This is a blunt text match,
 * not a semantic classifier — that tradeoff is the actual, honest scope of a
 * filter that costs no model call and needs no native dependency.
 */
export const WAKE_WORD_GATE_PATTERN = /(xayra|zaira|cyra|zyra|exayra)/i;

/** True if `transcript` contains the wake word or one of its known
 * phonetic near-misses — see the long comment above. */
export function containsWakeWord(transcript: string): boolean {
  return WAKE_WORD_GATE_PATTERN.test(transcript.trim());
}

/**
 * Drives the continuous "listen → auto-stop on silence → hand off →
 * re-arm" loop for Active/"Shower" Mode. Framework-agnostic (no React) —
 * see useActiveMode below for the hook that wires it into a screen.
 *
 * Owns its own @fugood/react-native-audio-pcm-stream session, independent
 * of services/audio/recorder.ts's useVoiceRecorder — callers are
 * responsible for not running both at once (the manual mic button is
 * disabled by both Notes and Chat screens while Active Mode is engaged),
 * since the native module supports only one capture session at a time.
 */
export class ActiveModeManager {
  private readonly callbacks: ActiveModeCallbacks;
  private _state: ActiveModeState = "idle";
  private stopped = true;

  private chunks: Buffer[] = [];
  private subscription: { remove: () => void } | null = null;
  private silenceCheckTimer: ReturnType<typeof setInterval> | null = null;

  private hasDetectedSpeech = false;
  private lastVoiceAt = 0;
  private utteranceStartedAt = 0;

  // Adaptive noise-floor calibration state — see the constants' own doc
  // comment above. Reset at the top of every `armListening()` call.
  private calibrationEndsAt = 0;
  private noiseFloorSamples: number[] = [];
  private speechRmsThreshold = MAX_SPEECH_RMS_THRESHOLD;

  constructor(callbacks: ActiveModeCallbacks) {
    this.callbacks = callbacks;
  }

  get state(): ActiveModeState {
    return this._state;
  }

  private setState(next: ActiveModeState): void {
    this._state = next;
    this.callbacks.onStateChange?.(next);
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      throw new Error("Microphone permission was not granted.");
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    // Keeps the screen (and CPU) awake for as long as Active Mode is
    // engaged, so a hands-free/shower session isn't cut short by the
    // device auto-locking mid-listen. This only covers the foreground —
    // backgrounding the app or a manual power-button lock still suspends
    // recording; a true background foreground-service is a separate,
    // materially larger native undertaking not implemented here.
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    this.stopped = false;
    this.armListening();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearSilenceCheck();
    try {
      AudioRecord.stop();
    } catch {
      // Already stopped — fine.
    }
    this.subscription?.remove();
    this.subscription = null;
    this.chunks = [];
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
    this.setState("idle");
  }

  private armListening(): void {
    if (this.stopped) {
      return;
    }
    this.chunks = [];
    this.hasDetectedSpeech = false;
    this.utteranceStartedAt = Date.now();
    this.lastVoiceAt = Date.now();

    // Fresh calibration every cycle — a re-armed session after an utterance
    // may be in a physically different, differently-noisy moment (someone
    // started the shower, a fan kicked in, etc.), so the noise floor is
    // never carried over from a previous cycle.
    this.calibrationEndsAt = Date.now() + NOISE_FLOOR_CALIBRATION_MS;
    this.noiseFloorSamples = [];
    this.speechRmsThreshold = MAX_SPEECH_RMS_THRESHOLD;

    AudioRecord.init({ sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE });
    this.subscription?.remove();
    this.subscription = AudioRecord.on("data", (base64Chunk: string) => {
      const chunk = Buffer.from(base64Chunk, "base64");
      this.chunks.push(chunk);
      const rms = computeRms(chunk);

      if (Date.now() < this.calibrationEndsAt) {
        // Still sampling ambient noise — a speech-or-not decision isn't made
        // on this chunk at all yet, it just feeds the floor estimate.
        this.noiseFloorSamples.push(rms);
        return;
      }
      if (this.noiseFloorSamples.length > 0) {
        // Calibration window just ended — fold the samples into this
        // cycle's actual threshold exactly once, then clear them so this
        // branch doesn't re-run every chunk for the rest of the utterance.
        const noiseFloor =
          this.noiseFloorSamples.reduce((sum, sample) => sum + sample, 0) / this.noiseFloorSamples.length;
        this.speechRmsThreshold = Math.min(
          MAX_SPEECH_RMS_THRESHOLD,
          Math.max(MIN_SPEECH_RMS_THRESHOLD, noiseFloor * SPEECH_ABOVE_FLOOR_MULTIPLIER)
        );
        this.noiseFloorSamples = [];
      }

      if (rms > this.speechRmsThreshold) {
        this.hasDetectedSpeech = true;
        this.lastVoiceAt = Date.now();
      }
    });
    AudioRecord.start();
    this.setState("listening");

    this.clearSilenceCheck();
    this.silenceCheckTimer = setInterval(() => this.checkSilence(), SILENCE_POLL_INTERVAL_MS);
  }

  private clearSilenceCheck(): void {
    if (this.silenceCheckTimer) {
      clearInterval(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }
  }

  private checkSilence(): void {
    if (this.stopped || this._state !== "listening") {
      return;
    }
    const now = Date.now();
    const elapsed = now - this.utteranceStartedAt;
    const silentFor = now - this.lastVoiceAt;

    const hitMaxDuration = elapsed >= MAX_UTTERANCE_MS;
    const finishedSpeaking =
      this.hasDetectedSpeech && elapsed >= MIN_UTTERANCE_MS && silentFor >= SILENCE_HOLD_MS;

    if (hitMaxDuration || finishedSpeaking) {
      void this.finalizeUtterance();
    }
  }

  private async finalizeUtterance(): Promise<void> {
    this.clearSilenceCheck();
    if (this.stopped) {
      return;
    }

    try {
      AudioRecord.stop();
    } catch {
      // Already stopped — fine.
    }
    this.subscription?.remove();
    this.subscription = null;

    const hadSpeech = this.hasDetectedSpeech;
    const chunks = this.chunks;
    this.chunks = [];

    if (!hadSpeech || chunks.length === 0) {
      // Silence the whole way through (e.g. nobody's said anything yet) —
      // nothing to process, just keep listening.
      this.armListening();
      return;
    }

    this.setState("processing");
    try {
      const uri = await writePcmChunksAsWav(chunks, "active-mode");
      await this.callbacks.onUtterance(uri, (state) => this.setState(state));
    } catch (err) {
      this.callbacks.onError?.(err);
    } finally {
      if (!this.stopped) {
        this.armListening();
      }
    }
  }
}

export type UseActiveMode = {
  isActive: boolean;
  state: ActiveModeState;
  toggle: () => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * React wrapper around ActiveModeManager. `onUtterance` is read through a
 * ref so the hook doesn't need to tear down and recreate the underlying
 * manager (and its live mic session) every time the caller's callback
 * closure changes identity across renders.
 */
export function useActiveMode(onUtterance: ActiveModeUtteranceHandler): UseActiveMode {
  const [isActive, setIsActive] = useState(false);
  const [state, setState] = useState<ActiveModeState>("idle");
  const managerRef = useRef<ActiveModeManager | null>(null);
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  useEffect(() => {
    const manager = new ActiveModeManager({
      onUtterance: (uri, reportState) => onUtteranceRef.current(uri, reportState),
      onStateChange: setState,
      onError: (err) => console.error("[ActiveMode] error", err),
    });
    managerRef.current = manager;
    return () => {
      void manager.stop();
    };
  }, []);

  const start = useCallback(async () => {
    await managerRef.current?.start();
    setIsActive(true);
  }, []);

  const stop = useCallback(async () => {
    await managerRef.current?.stop();
    setIsActive(false);
  }, []);

  const toggle = useCallback(async () => {
    if (isActive) {
      await stop();
    } else {
      await start();
    }
  }, [isActive, start, stop]);

  return { isActive, state, toggle, stop };
}
