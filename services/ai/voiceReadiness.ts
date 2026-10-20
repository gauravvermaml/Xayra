import { VOICE_MODEL_NOT_READY } from "../../constants/copy";
import { isWhisperModelDownloaded } from "./whisperModels";

/**
 * Whether voice capture can turn speech into text. PCM + Whisper is the only
 * transcription path (Tier 1 is off by default), so without the Whisper
 * model a recording could only fail to transcribe — and the spoken note
 * would be lost. Checked before the microphone starts (manual recording and
 * Handsfree); onboarding can be finished before the model has downloaded.
 */
export async function checkVoiceReady(): Promise<{ ready: true } | { ready: false; message: string }> {
  try {
    if (await isWhisperModelDownloaded()) return { ready: true };
  } catch {
    // An unreadable model path is treated as not installed.
  }
  return { ready: false, message: VOICE_MODEL_NOT_READY };
}
