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
 */
const SILENCE_RMS_THRESHOLD = 0.02;
const SILENCE_HOLD_MS = 1500;
/** Guards against a stray tap/cough finalizing a near-empty "utterance". */
const MIN_UTTERANCE_MS = 400;
/** Safety cap so a miscalibrated threshold (e.g. loud background noise
 * never dropping below SILENCE_RMS_THRESHOLD) can't record indefinitely. */
const MAX_UTTERANCE_MS = 60_000;
const SILENCE_POLL_INTERVAL_MS = 200;

const KEEP_AWAKE_TAG = "remi-active-mode";

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

    AudioRecord.init({ sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE });
    this.subscription?.remove();
    this.subscription = AudioRecord.on("data", (base64Chunk: string) => {
      const chunk = Buffer.from(base64Chunk, "base64");
      this.chunks.push(chunk);
      if (computeRms(chunk) > SILENCE_RMS_THRESHOLD) {
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
