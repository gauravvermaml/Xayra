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

/**
 * Confirmed on-device: at ~1m from the phone, Handsfree recordings
 * transcribe fine; at ~3m, results were "a mixed bag" — several came back
 * with the wake-word portion missing entirely (`""`, `"."`, a bare leading
 * comma), while the REST of the same sentence still transcribed correctly.
 * Root cause is nothing in the VAD/wake-word logic (both already tuned
 * separately) — it's that the raw mic PCM was written to the WAV completely
 * unamplified, at whatever level it happened to arrive at. Speech amplitude
 * falls off sharply with distance (inverse-square law), and a genuine,
 * well-documented speech phenomenon — an utterance's OWN first word/syllable
 * is typically spoken more softly than what follows ("onset softness") — is
 * exactly what a low-SNR distant recording has the least headroom to
 * survive. Whisper doesn't fail loudly on a too-quiet segment; it just
 * produces nothing for it.
 *
 * Fix: peak-normalize the finalized recording before it's ever written to
 * disk — scale every sample up toward (not past) full-scale by whatever
 * factor its own loudest moment needs, exactly like normalizing a music
 * track. This can only help intelligibility (it changes level, not
 * waveform shape) and costs one linear pass over audio that's at most a
 * handful of seconds long. `MAX_GAIN` caps how far a near-silent buffer can
 * be amplified — without it, a recording that's mostly just noise floor
 * (peak near zero) would get blown up into loud hiss/static, which would
 * make Whisper's output WORSE (more likely to hallucinate a non-speech
 * marker — see localWhisper.ts's NON_SPEECH_MARKER_PATTERN) rather than
 * better.
 */
const TARGET_PEAK_RATIO = 0.9;
const MAX_GAIN = 8;
const INT16_MAX = 32767;
const INT16_MIN = -32768;

/** Scales 16-bit little-endian mono PCM samples up toward (never past)
 * `TARGET_PEAK_RATIO` of full scale, based on the buffer's own loudest
 * sample — a no-op (gain 1) if the recording is already at or above that
 * level, so this only ever helps a quiet recording, never alters an
 * already-good one. Mutates and returns a new Buffer rather than the input. */
function normalizePcmGain(pcmData: Buffer): Buffer {
  const sampleCount = Math.floor(pcmData.length / 2);
  if (sampleCount === 0) {
    return pcmData;
  }

  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.abs(pcmData.readInt16LE(i * 2));
    if (sample > peak) {
      peak = sample;
    }
  }
  if (peak === 0) {
    // Genuinely all-zero buffer (shouldn't normally happen) — amplifying
    // silence by any factor is still silence, and dividing by peak below
    // would be a division by zero.
    return pcmData;
  }

  const gain = Math.min(MAX_GAIN, (INT16_MAX * TARGET_PEAK_RATIO) / peak);
  if (gain <= 1) {
    // Already loud enough (or louder) — leave it exactly as captured.
    return pcmData;
  }

  const normalized = Buffer.alloc(pcmData.length);
  for (let i = 0; i < sampleCount; i++) {
    const scaled = Math.round(pcmData.readInt16LE(i * 2) * gain);
    // Clamp rather than let a rounding edge case wrap around Int16's range.
    normalized.writeInt16LE(Math.max(INT16_MIN, Math.min(INT16_MAX, scaled)), i * 2);
  }
  return normalized;
}

/** Assembles raw PCM chunks into a playable WAV file on disk and returns its
 * uri. Shared by the manual recorder and Active Mode's auto-segmented loop —
 * both benefit from `normalizePcmGain` equally, since both feed whatever
 * they capture straight to the same on-device Whisper model. */
export async function writePcmChunksAsWav(chunks: Buffer[], filenamePrefix: string): Promise<string> {
  const pcmData = normalizePcmGain(Buffer.concat(chunks));
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
