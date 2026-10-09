/**
 * Deterministic "has someone spoken, and have they stopped?" detector,
 * shared by Handsfree (activeMode.ts) and the manual recorder's auto-finish
 * (recorder.ts). Fed one RMS value per mic chunk, plus the current time;
 * owns no timers, audio or React state, so both callers keep their own
 * polling and lifecycle.
 *
 * Simple energy-threshold VAD: distinguishes "someone is talking" from
 * "quiet room" by raw loudness alone. This is a real, known limitation —
 * it cannot distinguish a loud voice from loud *non-voice* noise (running
 * shower water, in particular, is close to continuous white noise loud
 * enough to sit above almost any reasonable threshold). It works well in an
 * ordinarily quiet room; a genuinely shower-safe VAD would need
 * spectral/energy-in-speech-band analysis or a real ML VAD model, neither
 * of which is implemented here. Documented rather than silently pretended
 * away — see PROJECT_STATE_HANDOFF.md.
 *
 * ADAPTIVE THRESHOLD (was a single fixed constant): confirmed on-device that
 * a fixed 0.02 RMS floor requires the phone to be within roughly arm's
 * length — speech from 2-3 meters away simply never crosses it, so speech
 * is never detected and the whole recording is discarded as "nothing said"
 * before Whisper ever runs. Root cause: mic input power falls off sharply
 * with distance, and one fixed threshold can't be right for both a close,
 * quiet room and a far, still-quiet room.
 *
 * Fix: each cycle (`reset`) samples the room's own ambient noise floor for
 * `NOISE_FLOOR_CALIBRATION_MS` before evaluating speech at all, then sets
 * that cycle's actual threshold to `noiseFloor * SPEECH_ABOVE_FLOOR_MULTIPLIER`,
 * clamped to [`MIN_SPEECH_RMS_THRESHOLD`, `MAX_SPEECH_RMS_THRESHOLD`]. The
 * upper clamp is the OLD fixed value — a loud room can never end up needing
 * a louder trigger than before, only a quiet one can end up needing a much
 * quieter (i.e. farther-away-friendly) one.
 */
const MIN_SPEECH_RMS_THRESHOLD = 0.006;
const MAX_SPEECH_RMS_THRESHOLD = 0.02;
const SPEECH_ABOVE_FLOOR_MULTIPLIER = 2.5;
/** How long each cycle spends sampling ambient noise before it starts
 * evaluating samples as speech/silence. Short enough that a user who starts
 * talking immediately only loses a fraction of a word to mis-calibration
 * (worst case: that fraction gets folded into the noise floor, nudging the
 * threshold up slightly for THIS cycle only — the next `reset` recalibrates
 * from zero). */
const NOISE_FLOOR_CALIBRATION_MS = 300;
/** Guards against a stray tap/cough finishing a near-empty utterance. */
const DEFAULT_MIN_UTTERANCE_MS = 400;

export type SilenceDetectorOptions = {
  /** How long the voice must stay below threshold, after speech, to count
   * as finished. */
  trailingSilenceMs: number;
  minUtteranceMs?: number;
};

export class TrailingSilenceDetector {
  private readonly trailingSilenceMs: number;
  private readonly minUtteranceMs: number;

  private startedAt = 0;
  private lastVoiceAt = 0;
  private speechDetected = false;
  private calibrationEndsAt = 0;
  private noiseFloorSamples: number[] = [];
  private speechRmsThreshold = MAX_SPEECH_RMS_THRESHOLD;

  constructor(options: SilenceDetectorOptions) {
    this.trailingSilenceMs = options.trailingSilenceMs;
    this.minUtteranceMs = options.minUtteranceMs ?? DEFAULT_MIN_UTTERANCE_MS;
  }

  /** Starts a fresh cycle: new calibration, no speech heard yet. A re-armed
   * cycle may be in a physically different, differently-noisy moment, so
   * the noise floor is never carried over. */
  reset(now: number): void {
    this.startedAt = now;
    this.lastVoiceAt = now;
    this.speechDetected = false;
    this.calibrationEndsAt = now + NOISE_FLOOR_CALIBRATION_MS;
    this.noiseFloorSamples = [];
    this.speechRmsThreshold = MAX_SPEECH_RMS_THRESHOLD;
  }

  /** Records one chunk's loudness. */
  push(rms: number, now: number): void {
    if (now < this.calibrationEndsAt) {
      // Still sampling ambient noise — no speech decision on this chunk.
      this.noiseFloorSamples.push(rms);
      return;
    }
    if (this.noiseFloorSamples.length > 0) {
      // Calibration just ended — fold the samples into this cycle's
      // threshold exactly once.
      const noiseFloor =
        this.noiseFloorSamples.reduce((sum, sample) => sum + sample, 0) / this.noiseFloorSamples.length;
      this.speechRmsThreshold = Math.min(
        MAX_SPEECH_RMS_THRESHOLD,
        Math.max(MIN_SPEECH_RMS_THRESHOLD, noiseFloor * SPEECH_ABOVE_FLOOR_MULTIPLIER)
      );
      this.noiseFloorSamples = [];
    }
    if (rms > this.speechRmsThreshold) {
      this.speechDetected = true;
      this.lastVoiceAt = now;
    }
  }

  get hasDetectedSpeech(): boolean {
    return this.speechDetected;
  }

  /** Milliseconds since this cycle began. */
  elapsed(now: number): number {
    return now - this.startedAt;
  }

  /** True once speech has been heard and has been followed by
   * `trailingSilenceMs` of quiet. Never true before any speech. */
  hasFinishedSpeaking(now: number): boolean {
    return (
      this.speechDetected &&
      now - this.startedAt >= this.minUtteranceMs &&
      now - this.lastVoiceAt >= this.trailingSilenceMs
    );
  }
}
