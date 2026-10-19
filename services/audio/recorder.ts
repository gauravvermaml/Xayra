import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, type AppStateStatus } from "react-native";
import { Buffer } from "buffer";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { logDuration, nowMs } from "../ai/perf";
import { getMicSnapshot, MicBusyError, openMicSession, stopMicSession, type CapturedAudio } from "./micSession";
import { pausePlayback } from "./player";
import { TrailingSilenceDetector } from "./silenceDetector";
import { stopSpeech } from "./tts";
import { BITS_PER_SAMPLE, CHANNELS, SAMPLE_RATE, computeRms, writePcmChunksAsWav } from "./wav";

export type StartRecordingOptions = {
  /** Finish automatically once speech has been heard and then followed by
   * this much trailing silence. Omitted = finish only on a manual stop. */
  autoStopAfterSilenceMs?: number;
  /** Called at most once per recording, when that trailing silence is
   * reached. The recorder keeps recording; the caller decides to stop. */
  onAutoStop?: () => void;
};

export type VoiceRecorder = {
  isRecording: boolean;
  /** True while a start/stop transition is in flight; guards double-taps. */
  isTransitioning: boolean;
  /** Live 0..1 RMS amplitude of the current PCM chunk, updated on every
   * `data` event while recording (0 whenever not recording) — the real
   * microphone-metering signal the jet-black canvas's waveform (State B)
   * animates off of, not a canned/synthetic pulse. */
  amplitude: number;
  requestPermissions: () => Promise<boolean>;
  /** Resolves true once the microphone is capturing; false if the start
   * was cancelled (stopRecording called, or the screen went away) before
   * the native session opened — no capture is left running. */
  startRecording: (options?: StartRecordingOptions) => Promise<boolean>;
  stopRecording: () => Promise<string | null>;
  /** Cancel: stops capture and throws the audio away — no WAV is written,
   * so there is no file to clean up. Aborts a start that hasn't opened the
   * microphone yet. If the native stop call itself throws, the microphone
   * was never told to stop, so nothing is reported free: the recording is
   * left exactly as it was and the error is rethrown. A no-op when nothing
   * is recording or a stop is in flight. */
  discardRecording: () => Promise<void>;
};

/**
 * Kept from the legacy path until the release acknowledgement's own drain
 * (micSession: every chunk up to the native lastSeq) has been validated on
 * the emulator; removed in Gate B step 5.
 */
const STOP_DRAIN_MS = 200;

/** Shown when a recording's audio may be missing a part (Gate B). */
function warnIfIncomplete(audio: CapturedAudio | null): void {
  if (!audio || audio.complete) return;
  Alert.alert(
    "Recording May Be Incomplete",
    "Part of this recording may be missing. If this note looks wrong, please try recording it again."
  );
}
/** How often the auto-stop check runs — same cadence as Handsfree's. */
const SILENCE_POLL_INTERVAL_MS = 200;

/**
 * Wraps @fugood/react-native-audio-pcm-stream with the lifecycle shape this
 * app needs: permission check, start, and stop-returning-a-WAV-file-uri.
 */
export function useVoiceRecorder(): VoiceRecorder {
  const [isRecording, setIsRecording] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  // Synchronous lock: setIsTransitioning only takes effect on the next
  // render, which isn't fast enough to block a second tap fired in the
  // same event-loop turn as the first.
  const isBusyRef = useRef(false);
  /** The native microphone session of the current recording. */
  const sessionIdRef = useRef<number | null>(null);
  // Kept in step with `isRecording` synchronously (not on render), so a
  // stop requested from the auto-stop timer and one from a tap in the same
  // moment can't both get through.
  const isRecordingRef = useRef(false);
  const autoStopTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearAutoStop = useCallback(() => {
    if (autoStopTimerRef.current) {
      clearInterval(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  }, []);
  // A start can be cancelled while it's still awaiting permissions/audio
  // session setup: stopRecording() or the screen unmounting sets this, and
  // startRecording bails out before opening the native session. Without
  // it, a start in flight when its screen unmounted kept the mic running
  // as an orphan nothing could stop (confirmed on-device: a launcher
  // shortcut's activity re-creation left a "ghost" recording that later
  // auto-finished and was processed by the dead screen).
  const startAbortRef = useRef(false);
  useEffect(
    () => () => {
      // Whoever owned this recorder is gone: never leave its capture open.
      // micSession lives on and finishes confirming the release; the
      // microphone stays "in use" until it has.
      startAbortRef.current = true;
      clearAutoStop();
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      if (id !== null) {
        void stopMicSession(id, { discard: true });
      }
      isRecordingRef.current = false;
    },
    [clearAutoStop]
  );

  /**
   * Build 42 P1-4 fix: recording has no real backgrounding resilience (no
   * foreground service — a "materially larger undertaking" per this
   * project's own existing assessment of the equivalent Handsfree
   * limitation, and explicitly not attempted here per the user's own
   * decision). What IS in scope: never let a recording that was backgrounded
   * mid-capture finalize silently as if nothing happened — Android's
   * background-mic restrictions can starve real samples during that window,
   * so the resulting note may be missing audio with no other symptom at all.
   * This flag is set the moment a background transition is observed while
   * `isRecording` is true, and checked once in `stopRecording()`'s finalize
   * step to decide whether to warn.
   */
  const backgroundedDuringRecordingRef = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState === "background" && isRecordingRef.current) {
        backgroundedDuringRecordingRef.current = true;
      }
    });
    return () => subscription.remove();
  }, []);

  const requestPermissions = useCallback(async () => {
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      return granted;
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  const startRecording = useCallback(async (options?: StartRecordingOptions) => {
    if (isBusyRef.current) {
      return false;
    }
    isBusyRef.current = true;
    startAbortRef.current = false;
    setIsTransitioning(true);
    try {
      // Check before asking: requesting launches the system permission
      // activity even when permission is already granted (confirmed in the
      // event log — it paused the app and cost ~300-400 ms per start).
      let granted = false;
      try {
        granted = (await getRecordingPermissionsAsync()).granted;
      } catch {
        // Unknown — fall through to the normal request.
      }
      if (!granted) {
        granted = await requestPermissions();
      }
      if (!granted) {
        throw new Error("Microphone permission was not granted.");
      }

      // Build 42 P1-1a fix (qa/05-consolidated-triage.md P1-1): the "single
      // active audio source app-wide" invariant was enforced for TTS↔note-
      // playback but never extended to cover starting a recording as a third
      // competing source — a note or Handsfree answer's own narration could
      // keep playing audibly while a fresh recording captured over it.
      await stopSpeech();
      pausePlayback();

      // Build 42 P2-4 (best-effort): `doNotMix` tells Android this app's
      // audio session should yield (not blend with) another app's playback
      // or an incoming call — this is a genuine, if partial, fix: it governs
      // PLAYBACK focus behavior correctly, but the raw `AudioRecord`-based
      // capture this module uses (VOICE_RECOGNITION source, not a
      // MediaRecorder/AudioTrack-backed one) doesn't itself request or
      // respect Android's audio-focus system the way a focus-aware playback
      // stack does — a phone call arriving mid-recording is a real,
      // documented, currently-unaddressed platform limitation, not
      // something this setting alone closes. See activeMode.ts's identical
      // setting and doc comment for the Handsfree side of the same gap.
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
      });

      // The last moment before the native session opens.
      if (startAbortRef.current) {
        return false;
      }

      // This recorder's own earlier session whose stop request failed: the
      // tap to record first retries closing it.
      const stuck = sessionIdRef.current;
      if (stuck !== null && getMicSnapshot().phase === "stopFailed") {
        const retried = await stopMicSession(stuck, { discard: true });
        if (retried.kind === "stopFailed") throw new MicBusyError("stopFailed");
        sessionIdRef.current = null;
      }

      backgroundedDuringRecordingRef.current = false;

      // Auto-finish uses the same adaptive speech / trailing-silence
      // detector as Handsfree (silenceDetector.ts). It never fires before
      // speech has been heard, and there is no maximum length — a manual
      // tap can always finish.
      clearAutoStop();
      const autoStopMs = options?.autoStopAfterSilenceMs;
      const detector = autoStopMs ? new TrailingSilenceDetector({ trailingSilenceMs: autoStopMs }) : null;
      detector?.reset(Date.now());

      // The microphone session (micSession keeps every chunk, in order,
      // for stopRecording); the live chunks drive metering and auto-finish.
      const id = await openMicSession(
        "manual",
        { sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE },
        {
          onChunk: (base64Chunk) => {
            const rms = computeRms(Buffer.from(base64Chunk, "base64"));
            setAmplitude(rms);
            detector?.push(rms, Date.now());
          },
          // Build 42 P1-5: a mid-recording mic-permission revocation or
          // native `AudioRecord` failure is surfaced, never finalized as if
          // nothing happened.
          onError: (message) => {
            console.error("[AudioRecorder] Native recording error:", message);
            Alert.alert(
              "Recording Error",
              "Something went wrong while recording — this note may be incomplete or empty. Please try again."
            );
          },
        },
        { collect: true }
      );
      sessionIdRef.current = id;
      // Cancelled (or the screen went away) while the session was opening.
      if (startAbortRef.current) {
        sessionIdRef.current = null;
        void stopMicSession(id, { discard: true });
        return false;
      }
      isRecordingRef.current = true;
      setIsRecording(true);

      if (detector) {
        autoStopTimerRef.current = setInterval(() => {
          if (!detector.hasFinishedSpeaking(Date.now())) {
            return;
          }
          clearAutoStop();
          options?.onAutoStop?.();
        }, SILENCE_POLL_INTERVAL_MS);
      }
      return true;
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      isBusyRef.current = false;
      setIsTransitioning(false);
    }
  }, [requestPermissions, clearAutoStop]);

  const stopRecording = useCallback(async () => {
    if (isBusyRef.current && !isRecordingRef.current) {
      // A start is still in flight: cancel it rather than let it open the
      // microphone after the caller has given up on it.
      startAbortRef.current = true;
      return null;
    }
    if (isBusyRef.current || !isRecordingRef.current) {
      return null;
    }
    isBusyRef.current = true;
    setIsTransitioning(true);
    clearAutoStop();
    try {
      const id = sessionIdRef.current;
      // Resolves once the native release is confirmed (or reports why it
      // couldn't be): the audio comes back complete, or marked incomplete.
      const result = id !== null ? await stopMicSession(id) : null;
      if (result?.kind === "stopFailed") {
        // The capture was never told to stop: still recording.
        throw new MicBusyError("stopFailed");
      }
      sessionIdRef.current = null;
      await new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_MS));
      isRecordingRef.current = false;
      setIsRecording(false);
      setAmplitude(0);

      const finalizeStart = nowMs();
      // Missing parts are left out of the WAV but never hidden: an
      // incomplete recording is still processed (what was captured is the
      // user's words), with a warning.
      const audio = result ? result.audio : null;
      const chunks = audio?.chunks ?? [];

      const uri = await writePcmChunksAsWav(chunks, "note");
      logDuration("Audio I/O — WAV finalize (concat + base64 write)", finalizeStart);

      console.log("[AudioRecorder] File written:", uri);
      warnIfIncomplete(audio);

      if (backgroundedDuringRecordingRef.current) {
        backgroundedDuringRecordingRef.current = false;
        // Honest, not silent: we don't actually know whether Android's
        // background-mic restrictions dropped real audio during that
        // window — only that the opportunity for it existed. Per the
        // user's own explicit decision (qa/07-phase2-execution-brief.md),
        // this is the scope: tell them clearly rather than build a full
        // background-capable recording session.
        Alert.alert(
          "Recording May Be Incomplete",
          "The app was in the background for part of this recording, which can affect what got captured. If this note looks wrong, please try recording it again."
        );
      }

      return uri;
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      isBusyRef.current = false;
      setIsTransitioning(false);
    }
  }, [clearAutoStop]);

  const discardRecording = useCallback(async () => {
    if (isBusyRef.current && !isRecordingRef.current) {
      startAbortRef.current = true;
      return;
    }
    if (isBusyRef.current || !isRecordingRef.current) {
      return;
    }
    isBusyRef.current = true;
    setIsTransitioning(true);
    clearAutoStop();
    try {
      const id = sessionIdRef.current;
      // Nothing captured is kept. micSession reports the microphone free
      // only once the native release is confirmed.
      const result = id !== null ? await stopMicSession(id, { discard: true }) : null;
      if (result?.kind === "stopFailed") {
        // The capture was never told to stop: the recording is left as it
        // was, and the caller hears about it.
        throw result.error instanceof Error ? result.error : new MicBusyError("stopFailed");
      }
      sessionIdRef.current = null;
      isRecordingRef.current = false;
      backgroundedDuringRecordingRef.current = false;
      setIsRecording(false);
      setAmplitude(0);
    } finally {
      isBusyRef.current = false;
      setIsTransitioning(false);
    }
  }, [clearAutoStop]);

  return {
    isRecording,
    isTransitioning,
    amplitude,
    requestPermissions,
    startRecording,
    stopRecording,
    discardRecording,
  };
}
