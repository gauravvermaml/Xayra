import { Buffer } from "buffer";
import * as FileSystem from "expo-file-system/legacy";

/**
 * whisper.rn (whisper.cpp) only decodes raw 16-bit PCM WAV — it explicitly
 * does not decode compressed formats like AAC/MP3/FLAC. Android's
 * MediaRecorder has no WAV/raw output option at all, so every recording
 * path in this app (manual mic button and Active Mode alike) captures raw
 * PCM via @fugood/react-native-audio-pcm-stream and hand-assembles it into
 * a WAV file here. 16kHz mono also matches what whisper.cpp models expect.
 */
export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;

export const RECORDINGS_DIR = `${FileSystem.documentDirectory}recordings/`;

export function buildWavHeader(dataSize: number): Uint8Array {
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

/** Below this, a WAV recording is treated as a blank/misfire tap rather than
 * genuine speech — see the BLANK AUDIO & SILENCE GUARD requirement shared by
 * both the Notes and Chat voice pipelines (app/index.tsx). 0.5s of 16kHz
 * mono 16-bit PCM, plus the 44-byte header this app always writes. */
const MIN_SPEECH_DURATION_SECONDS = 0.5;
const BYTES_PER_SECOND = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
const WAV_HEADER_BYTES = 44;
export const MIN_SPEECH_AUDIO_BYTES =
  WAV_HEADER_BYTES + Math.ceil(BYTES_PER_SECOND * MIN_SPEECH_DURATION_SECONDS);

/** Cheap duration check straight from the file's byte size — no need to
 * parse/decode the WAV to know whether it's under the ~0.5s "that was
 * basically silence/a stray tap" threshold. */
export async function isAudioTooShort(uri: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  return !info.exists || (info.size ?? 0) < MIN_SPEECH_AUDIO_BYTES;
}

export async function ensureRecordingsDirExists(): Promise<void> {
  const info = await FileSystem.getInfoAsync(RECORDINGS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(RECORDINGS_DIR, { intermediates: true });
  }
}

/** Assembles raw PCM chunks into a playable WAV file on disk and returns its
 * uri. Shared by the manual recorder and Active Mode's auto-segmented loop. */
export async function writePcmChunksAsWav(chunks: Buffer[], filenamePrefix: string): Promise<string> {
  const pcmData = Buffer.concat(chunks);
  const wavBytes = Buffer.concat([Buffer.from(buildWavHeader(pcmData.length)), pcmData]);

  await ensureRecordingsDirExists();
  const uri = `${RECORDINGS_DIR}${filenamePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
  await FileSystem.writeAsStringAsync(uri, wavBytes.toString("base64"), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return uri;
}

/** Root-mean-square amplitude of a 16-bit little-endian mono PCM buffer,
 * normalized to 0..1 (1 = full-scale). A cheap, dependency-free stand-in for
 * a real VAD model — good enough to distinguish "someone is talking" from
 * "background shower noise" once a threshold is tuned, without pulling in a
 * neural VAD model or its own inference cost on every audio chunk. */
export function computeRms(chunk: Buffer): number {
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = chunk.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms / 32768;
}
