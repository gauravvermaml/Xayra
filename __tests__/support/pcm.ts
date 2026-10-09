import { Buffer } from "buffer";

/** Samples per synthetic mic chunk: 1024 at 16 kHz = 64 ms. */
export const CHUNK_MS = 64;
const CHUNK_SAMPLES = 1024;

/** A 16-bit mono PCM chunk whose RMS is exactly `level` (0..1), as the
 * native recorder would deliver it (base64). */
export function pcmChunkBase64(level: number): string {
  const buf = Buffer.alloc(CHUNK_SAMPLES * 2);
  const sample = Math.round(level * 32768);
  for (let i = 0; i < CHUNK_SAMPLES; i++) buf.writeInt16LE(Math.min(32767, sample), i * 2);
  return buf.toString("base64");
}

/** Feeds `durationMs` of audio at `level` through `emit`, advancing Jest's
 * fake clock one chunk at a time so timers and Date.now() move with it. */
export function feedAudio(emit: (base64: string) => void, level: number, durationMs: number): void {
  for (let t = 0; t < durationMs; t += CHUNK_MS) {
    jest.advanceTimersByTime(CHUNK_MS);
    emit(pcmChunkBase64(level));
  }
}

export const QUIET = 0.001;
export const SPEECH = 0.05;
