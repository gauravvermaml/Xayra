#!/usr/bin/env node
/**
 * Synthesizes a short two-tone "wake acknowledged" chime as a raw 16-bit PCM
 * WAV file — no external audio asset, no licensing question, no dependency
 * (ffmpeg/etc.) needed. Run once to (re)generate assets/sounds/wake_chime.wav;
 * not part of the app's runtime build.
 *
 * WAV, not MP3: expo-audio plays WAV natively and a valid WAV is trivial to
 * hand-assemble as raw bytes (see services/audio/wav.ts's buildWavHeader,
 * which this mirrors); a correct MP3 encoder is not something to hand-roll.
 *
 * Two notes (A5 -> E6, a rising perfect fifth — reads as "acknowledged/
 * ready", not an alarm), each with a short linear fade-in/out envelope so
 * the tone starts/stops cleanly instead of clicking, and each fixed to zero
 * at its own boundary so concatenating them never introduces a discontinuity.
 */
const fs = require("fs");
const path = require("path");

const SAMPLE_RATE = 16000; // matches services/audio/wav.ts's recording format
const AMPLITUDE = 0.35 * 32767; // comfortably below full-scale -- a UI chime, not a peak-normalized recording

function tone(freqHz, durationMs, fadeMs) {
  const sampleCount = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const fadeSamples = Math.round((fadeMs / 1000) * SAMPLE_RATE);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / SAMPLE_RATE;
    let envelope = 1;
    if (i < fadeSamples) {
      envelope = i / fadeSamples;
    } else if (i > sampleCount - fadeSamples) {
      envelope = (sampleCount - i) / fadeSamples;
    }
    samples[i] = Math.round(Math.sin(2 * Math.PI * freqHz * t) * AMPLITUDE * envelope);
  }
  return samples;
}

const noteA = tone(880.0, 130, 12); // A5
const noteE = tone(1318.51, 170, 15); // E6, a perfect fifth above A5
const silence = new Int16Array(Math.round(0.01 * SAMPLE_RATE)); // 10ms gap between notes

const allSamples = new Int16Array(noteA.length + silence.length + noteE.length);
allSamples.set(noteA, 0);
allSamples.set(silence, noteA.length);
allSamples.set(noteE, noteA.length + silence.length);

const dataSize = allSamples.length * 2;
const header = Buffer.alloc(44);
header.write("RIFF", 0, "ascii");
header.writeUInt32LE(36 + dataSize, 4);
header.write("WAVE", 8, "ascii");
header.write("fmt ", 12, "ascii");
header.writeUInt32LE(16, 16); // fmt chunk size
header.writeUInt16LE(1, 20); // audio format: PCM
header.writeUInt16LE(1, 22); // channels: mono
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate (16-bit mono)
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write("data", 36, "ascii");
header.writeUInt32LE(dataSize, 40);

const pcmBuffer = Buffer.from(allSamples.buffer, allSamples.byteOffset, allSamples.byteLength);
const wavBuffer = Buffer.concat([header, pcmBuffer]);

const outPath = path.join(__dirname, "..", "assets", "sounds", "wake_chime.wav");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, wavBuffer);
console.log(`Wrote ${wavBuffer.length} bytes to ${outPath}`);
