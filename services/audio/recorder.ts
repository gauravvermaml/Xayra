import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type AudioRecorder,
} from "expo-audio";

export type VoiceRecorder = {
  isRecording: boolean;
  /** True while a start/stop transition is in flight; guards double-taps. */
  isTransitioning: boolean;
  requestPermissions: () => Promise<boolean>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
};

function isAlreadyPreparedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already prepared|already recording/i.test(message);
}

/**
 * Guards against calling a method the linked native module build doesn't
 * actually expose — a mismatched/stale dev client otherwise surfaces this
 * as an opaque "undefined is not a function" deep inside a native call.
 */
function assertMethod<T extends (...args: never[]) => unknown>(
  recorder: AudioRecorder,
  methodName: keyof AudioRecorder
): T {
  const method = recorder[methodName];
  if (typeof method !== "function") {
    throw new Error(
      `expo-audio: AudioRecorder.${String(methodName)} is not available on this build. ` +
        "The native dev client is likely out of date — rebuild it."
    );
  }
  return method.bind(recorder) as T;
}

/**
 * Wraps expo-audio's recorder hook with the lifecycle shape this app needs:
 * permission check, start, and stop-returning-file-uri.
 */
export function useVoiceRecorder(): VoiceRecorder {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isTransitioning, setIsTransitioning] = useState(false);
  // Synchronous lock: setIsTransitioning only takes effect on the next
  // render, which isn't fast enough to block a second tap fired in the
  // same event-loop turn as the first.
  const isBusyRef = useRef(false);

  const requestPermissions = useCallback(async () => {
    try {
      // Uses the top-level exported function rather than reaching into the
      // internal `AudioModule` singleton, which is `@hidden` and not part
      // of the stable public surface.
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

      const getStatus = assertMethod<() => ReturnType<AudioRecorder["getStatus"]>>(
        recorder,
        "getStatus"
      );
      const stop = assertMethod<AudioRecorder["stop"]>(recorder, "stop");
      const prepareToRecordAsync = assertMethod<AudioRecorder["prepareToRecordAsync"]>(
        recorder,
        "prepareToRecordAsync"
      );
      const record = assertMethod<AudioRecorder["record"]>(recorder, "record");

      const status = getStatus();
      if (status.isRecording) {
        // A session from a previous prepare/record call is still active;
        // stop it cleanly rather than preparing on top of it.
        await stop();
      }

      try {
        await prepareToRecordAsync();
      } catch (err) {
        if (!isAlreadyPreparedError(err)) {
          throw err;
        }
        // Recorder was already prepared (e.g. from a prior tap that raced
        // this one) — safe to proceed straight to record().
      }

      record();
    } catch (err) {
      Alert.alert("Recording Error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      isBusyRef.current = false;
      setIsTransitioning(false);
    }
  }, [recorder, requestPermissions]);

  const stopRecording = useCallback(async () => {
    if (isBusyRef.current || !recorder.isRecording) {
      return null;
    }
    isBusyRef.current = true;
    setIsTransitioning(true);
    try {
      const stop = assertMethod<AudioRecorder["stop"]>(recorder, "stop");
      await stop();
      const uri = recorder.uri;

      // Diagnostic for the emulator's mic-routing issue: a suspiciously
      // small file (or one Whisper can only read as silence/dots) usually
      // means the host mic isn't actually reaching the AVD.
      if (uri && typeof FileSystem.getInfoAsync === "function") {
        const fileInfo = await FileSystem.getInfoAsync(uri);
        console.log(
          "[AudioRecorder] File size:",
          fileInfo.exists ? fileInfo.size : "(file missing)"
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
  }, [recorder]);

  return {
    isRecording: recorder.isRecording,
    isTransitioning,
    requestPermissions,
    startRecording,
    stopRecording,
  };
}
