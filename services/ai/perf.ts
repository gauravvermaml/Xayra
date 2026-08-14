/**
 * Lightweight on-device timing for the local AI pipeline (recording →
 * transcription → embedding → search → generation). Plain console.log
 * output so it shows up in Metro/logcat with zero extra tooling — this is a
 * diagnostic aid for spotting where latency actually goes, not a metrics
 * pipeline with retention/aggregation.
 */
export function nowMs(): number {
  return performance.now();
}

/** Logs `label` took (now - startMs) ms and returns that duration. */
export function logDuration(label: string, startMs: number): number {
  const durationMs = performance.now() - startMs;
  console.log(`[Perf] ${label}: ${durationMs.toFixed(0)}ms`);
  return durationMs;
}
