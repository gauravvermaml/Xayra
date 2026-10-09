import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, type AppStateStatus } from "react-native";
import { Buffer } from "buffer";
import { requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import AudioRecord from "@fugood/react-native-audio-pcm-stream";

import { logDuration, nowMs } from "../ai/perf";
import { isMicInUse, setMicInUse } from "./audioInputState";
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
  startRecording: (options?: StartRecordingOptions) => Promise<void>;
  stopRecording: () => Promise<string | null>;
};

/**
 * The native module's `stop()` just flips a flag — its background read loop
 * notices and exits asynchronously, so one more `data` chunk can arrive
 * after `stop()` returns. Waiting briefly before finalizing avoids losing
 * the tail end of the recording.
 */
const STOP_DRAIN_MS = 200;
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
  const chunksRef = useRef<Buffer[]>([]);
  const subscriptionRef = useRef<{ remove: () => void } | null>(null);
  const errorSubscriptionRef = useRef<{ remove: () => void } | null>(null);
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
  useEffect(() => clearAutoStop, [clearAutoStop]);

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
      return;
    }
    isBusyRef.current = true;
    setIsTransitioning(true);
    try {
      const granted = await requestPermissions();
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

      chunksRef.current = [];
      backgroundedDuringRecordingRef.current = false;
      subscriptionRef.current?.remove();
      errorSubscriptionRef.current?.remove();

      // Auto-finish uses the same adaptive speech / trailing-silence
      // detector as Handsfree (silenceDetector.ts). It never fires before
      // speech has been heard, and there is no maximum length — a manual
      // tap can always finish.
      clearAutoStop();
      const autoStopMs = options?.autoStopAfterSilenceMs;
      const detector = autoStopMs ? new TrailingSilenceDetector({ trailingSilenceMs: autoStopMs }) : null;
      detector?.reset(Date.now());

      AudioRecord.init({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        bitsPerSample: BITS_PER_SAMPLE,
      });
      subscriptionRef.current = AudioRecord.on("data", (base64Chunk) => {
        const chunk = Buffer.from(base64Chunk, "base64");
        chunksRef.current.push(chunk);
        const rms = computeRms(chunk);
        setAmplitude(rms);
        detector?.push(rms, Date.now());
      });
      // Build 42 P1-5 fix: the native module previously had no error
      // channel at all — a mid-recording mic-permission revocation or
      // native `AudioRecord` failure was invisible end-to-end (`isRecording`
      // stayed true, no alert fired, and `stopRecording()` would happily
      // finalize whatever partial/empty chunks had arrived into a normal-
      // looking WAV file). Requires the native patch adding this event —
      // see patches/@fugood+react-native-audio-pcm-stream+1.1.4.patch.
      errorSubscriptionRef.current = AudioRecord.on("error", (message) => {
        console.error("[AudioRecorder] Native recording error:", message);
        Alert.alert(
          "Recording Error",
          "Something went wrong while recording — this note may be incomplete or empty. Please try again."
        );
      });

      AudioRecord.start();
      isRecordingRef.current = true;
      setIsRecording(true);
      setMicInUse(true);

      if (detector) {
        autoStopTimerRef.current = setInterval(() => {
          if (!detector.hasFinishedSpeaking(Date.now())) {
            return;
          }
          clearAutoStop();
          options?.onAutoStop?.();
        }, SILENCE_POLL_INTERVAL_MS);
      }
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      isBusyRef.current = false;
      setIsTransitioning(false);
    }
  }, [requestPermissions, clearAutoStop]);

  const stopRecording = useCallback(async () => {
    if (isBusyRef.current || !isRecordingRef.current) {
      return null;
    }
    isBusyRef.current = true;
    setIsTransitioning(true);
    clearAutoStop();
    try {
      AudioRecord.stop();
      // Let any in-flight final chunk land before we stop listening.
      await new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_MS));
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      errorSubscriptionRef.current?.remove();
      errorSubscriptionRef.current = null;
      isRecordingRef.current = false;
      setIsRecording(false);
      setAmplitude(0);
      setMicInUse(false);

      const finalizeStart = nowMs();
      const chunks = chunksRef.current;
      chunksRef.current = [];

      const uri = await writePcmChunksAsWav(chunks, "note");
      logDuration("Audio I/O — WAV finalize (concat + base64 write)", finalizeStart);

      console.log("[AudioRecorder] File written:", uri);

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

  return {
    isRecording,
    isTransitioning,
    amplitude,
    requestPermissions,
    startRecording,
    stopRecording,
  };
}
