import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import { Buffer } from "buffer";
import { requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import AudioRecord from "@fugood/react-native-audio-pcm-stream";

import { logDuration, nowMs } from "../ai/perf";
import { BITS_PER_SAMPLE, CHANNELS, SAMPLE_RATE, writePcmChunksAsWav } from "./wav";

export type VoiceRecorder = {
  isRecording: boolean;
  /** True while a start/stop transition is in flight; guards double-taps. */
  isTransitioning: boolean;
  requestPermissions: () => Promise<boolean>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  /** Discards everything captured so far and immediately starts a fresh
   * take, without ever finalizing a WAV file for the discarded audio. */
  cancelAndRestart: () => Promise<void>;
};

/**
 * The native module's `stop()` just flips a flag — its background read loop
 * notices and exits asynchronously, so one more `data` chunk can arrive
 * after `stop()` returns. Waiting briefly before finalizing avoids losing
 * the tail end of the recording.
 */
const STOP_DRAIN_MS = 200;

/**
 * Wraps @fugood/react-native-audio-pcm-stream with the lifecycle shape this
 * app needs: permission check, start, and stop-returning-a-WAV-file-uri.
 */
export function useVoiceRecorder(): VoiceRecorder {
  const [isRecording, setIsRecording] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  // Synchronous lock: setIsTransitioning only takes effect on the next
  // render, which isn't fast enough to block a second tap fired in the
  // same event-loop turn as the first.
  const isBusyRef = useRef(false);
  const chunksRef = useRef<Buffer[]>([]);
  const subscriptionRef = useRef<{ remove: () => void } | null>(null);

  const requestPermissions = useCallback(async () => {
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      return granted;
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  const startRecording = useCallback(async () => {
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

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      chunksRef.current = [];
      subscriptionRef.current?.remove();

      AudioRecord.init({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        bitsPerSample: BITS_PER_SAMPLE,
      });
      subscriptionRef.current = AudioRecord.on("data", (base64Chunk) => {
        chunksRef.current.push(Buffer.from(base64Chunk, "base64"));
      });

      AudioRecord.start();
      setIsRecording(true);
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      isBusyRef.current = false;
      setIsTransitioning(false);
    }
  }, [requestPermissions]);

  const stopRecording = useCallback(async () => {
    if (isBusyRef.current || !isRecording) {
      return null;
    }
    isBusyRef.current = true;
    setIsTransitioning(true);
    try {
      AudioRecord.stop();
      // Let any in-flight final chunk land before we stop listening.
      await new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_MS));
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      setIsRecording(false);

      const finalizeStart = nowMs();
      const chunks = chunksRef.current;
      chunksRef.current = [];

      const uri = await writePcmChunksAsWav(chunks, "note");
      logDuration("Audio I/O — WAV finalize (concat + base64 write)", finalizeStart);

      console.log("[AudioRecorder] File written:", uri);
      return uri;
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      isBusyRef.current = false;
      setIsTransitioning(false);
    }
  }, [isRecording]);

  const cancelAndRestart = useCallback(async () => {
    if (isBusyRef.current || !isRecording) {
      return;
    }
    isBusyRef.current = true;
    setIsTransitioning(true);
    try {
      AudioRecord.stop();
      await new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_MS));
      subscriptionRef.current?.remove();
      chunksRef.current = [];

      AudioRecord.init({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        bitsPerSample: BITS_PER_SAMPLE,
      });
      subscriptionRef.current = AudioRecord.on("data", (base64Chunk) => {
        chunksRef.current.push(Buffer.from(base64Chunk, "base64"));
      });
      AudioRecord.start();
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      isBusyRef.current = false;
      setIsTransitioning(false);
    }
  }, [isRecording]);

  return {
    isRecording,
    isTransitioning,
    requestPermissions,
    startRecording,
    stopRecording,
    cancelAndRestart,
  };
}
