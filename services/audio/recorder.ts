import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import { Buffer } from "buffer";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import { requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import AudioRecord from "@fugood/react-native-audio-pcm-stream";

export type VoiceRecorder = {
  isRecording: boolean;
  /** True while a start/stop transition is in flight; guards double-taps. */
  isTransitioning: boolean;
  requestPermissions: () => Promise<boolean>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
};

/**
 * whisper.rn (whisper.cpp) only decodes raw 16-bit PCM WAV — it explicitly
 * does not decode compressed formats like AAC/MP3/FLAC. Android's
 * MediaRecorder (what expo-audio's file-based recorder uses) has no WAV/raw
 * output option at all, so notes are captured directly as raw PCM via
 * @fugood/react-native-audio-pcm-stream (the same library whisper.rn's own
 * bundled realtime-transcription module pairs with) and hand-assembled into
 * a WAV file here, rather than recorded as .m4a and needing a separate
 * transcode step. 16kHz mono also matches what whisper.cpp models expect.
 */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/**
 * The native module's `stop()` just flips a flag — its background read loop
 * notices and exits asynchronously, so one more `data` chunk can arrive
 * after `stop()` returns. Waiting briefly before finalizing avoids losing
 * the tail end of the recording.
 */
const STOP_DRAIN_MS = 200;

const RECORDINGS_DIR = `${FileSystem.documentDirectory}recordings/`;

function buildWavHeader(dataSize: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;

  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);

  return new Uint8Array(header);
}

async function ensureRecordingsDirExists(): Promise<void> {
  const info = await FileSystem.getInfoAsync(RECORDINGS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(RECORDINGS_DIR, { intermediates: true });
  }
}

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

      const pcmData = Buffer.concat(chunksRef.current);
      chunksRef.current = [];

      const wavBytes = Buffer.concat([Buffer.from(buildWavHeader(pcmData.length)), pcmData]);

      await ensureRecordingsDirExists();
      const uri = `${RECORDINGS_DIR}note-${Crypto.randomUUID()}.wav`;
      await FileSystem.writeAsStringAsync(uri, wavBytes.toString("base64"), {
        encoding: FileSystem.EncodingType.Base64,
      });

      console.log("[AudioRecorder] File size:", wavBytes.length);
      return uri;
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
  };
}
