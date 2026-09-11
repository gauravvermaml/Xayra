import { readPreferences, writePreferences } from "../settings/preferences";

/**
 * Tracks real, on-device Llama generation throughput from actual completions
 * — never a synthetic one-shot benchmark. Exists because RAM alone turned
 * out to be a bad proxy for whether a device can usably run the 3B model:
 * a device can have plenty of RAM and still be too CPU-weak to generate at
 * an acceptable speed, and a single benchmark taken at the wrong moment
 * (before sustained-load thermal throttling kicks in, or while other
 * onboarding work is still competing for CPU) can misjudge a device in
 * either direction. See [[ram-tier-bad-proxy-for-cpu]] in project memory for
 * the on-device measurement (Redmi Note 8 Pro: 3B model, 2.4 tok/s
 * effective) that motivated this.
 */

/** Below this, generation feels unusably slow to a real user waiting for an
 * answer — chosen as a plain "would a person tolerate this" floor, not
 * derived from any benchmark suite. Roughly: a short one-sentence answer
 * (~20-30 tokens) lands in under 10s at this rate. */
export const MIN_USABLE_TOKENS_PER_SECOND = 4;

/** Only the most recent samples matter — a device's thermal/throughput
 * behavior from an hour or a week ago says little about right now, and a
 * short window keeps one throttled outlier from permanently dragging the
 * average down (or one lucky cool-and-idle sample from propping it up). */
const MAX_SAMPLES = 5;

/** Require at least this many real samples before trusting the average for
 * any tier decision — a single completion's speed is too noisy (prompt
 * length, what else was running, thermal state at that exact moment) to act
 * on alone. */
const MIN_SAMPLES_FOR_DECISION = 3;

/**
 * Records one real completion's throughput — call with
 * `result.timings.predicted_per_second` from llama.rn's own native timing
 * (never derived from wall-clock JS timestamps, which would also capture
 * this app's completion-queue wait time, not just actual generation speed).
 * Skip the throwaway prewarm completion (n_predict: 1) — one predicted token
 * is too noisy a sample to be worth recording at all.
 */
export async function recordCompletionSpeed(tokensPerSecond: number): Promise<void> {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
    return;
  }
  const prefs = await readPreferences();
  const samples = [...prefs.performanceSamples, tokensPerSecond].slice(-MAX_SAMPLES);
  await writePreferences({ performanceSamples: samples });
}

/** Null until at least `MIN_SAMPLES_FOR_DECISION` real completions have been
 * recorded — callers should treat null as "not enough data yet," never as
 * "0 tokens/sec." */
export async function getAverageTokensPerSecond(): Promise<number | null> {
  const prefs = await readPreferences();
  if (prefs.performanceSamples.length < MIN_SAMPLES_FOR_DECISION) {
    return null;
  }
  const sum = prefs.performanceSamples.reduce((total, sample) => total + sample, 0);
  return sum / prefs.performanceSamples.length;
}

/** Clears recorded samples — called whenever the active model changes (a
 * tier upgrade, or falling back after a failed one), since a throughput
 * history measured on one model size says nothing about another. */
export async function resetPerformanceSamples(): Promise<void> {
  await writePreferences({ performanceSamples: [] });
}
