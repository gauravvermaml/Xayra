import Constants from "expo-constants";

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

/**
 * True in development builds only: a Metro/debug build (`__DEV__`) or the
 * Xayra Dev variant (package `….dev`, which can be a standalone release-type
 * build used for realistic on-device timing). Always false in the
 * production app. Gate for development-only diagnostics.
 */
export function isDevelopmentBuild(): boolean {
  return __DEV__ || (Constants.expoConfig?.android?.package ?? "").endsWith(".dev");
}
