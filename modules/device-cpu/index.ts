import { requireNativeModule } from "expo-modules-core";

/**
 * Diagnostics/capability-sizing module: reads the device's *actual* CPU core
 * count from Android's own `Runtime.getRuntime().availableProcessors()`, so
 * on-device inference can size its thread pool to real hardware instead of a
 * number hardcoded for whichever device happened to be on the test bench.
 *
 * This exists because services/ai/localLlama.ts's Llama context used to be
 * initialized with a flat `n_threads: 4` — a value that was fine on an
 * 8-core device but, on a 4-core one (the Galaxy A50 this project has been
 * testing on), claimed the device's *entire* CPU for the whole duration of
 * a GBNF-grammar-constrained to-do extraction (confirmed on-device to run
 * 140+ seconds), starving the OS's own input-dispatch and render threads of
 * CPU time for that whole stretch — the actual cause of an on-device
 * "everything is frozen" symptom that survived many UI-layer fixes, since
 * the freeze was never in the UI code at all. Android-only, matching this
 * app's platform scope — see modules/app-signature/index.ts for the same
 * pattern this module follows.
 */
/** Mirrors Android's `ComponentCallbacks2.TRIM_MEMORY_*` constants relevant
 * to `onMemoryPressure` below — only the levels the native side actually
 * forwards (`RUNNING_LOW` and up, plus `onLowMemory()` mapped to `COMPLETE`). */
export const MemoryPressureLevel = {
  RUNNING_LOW: 10,
  RUNNING_CRITICAL: 15,
  COMPLETE: 80,
} as const;

export type MemoryInfo = {
  /** Free system-wide memory, in MB — NOT just this app's own usage. */
  availMB: number;
  totalMB: number;
  /** Android's own "below this, I'm willing to start killing background
   * processes for room" line — the same threshold `lowMemory` below checks
   * `availMB` against. */
  thresholdMB: number;
  /** Android's own verdict, not a threshold we picked ourselves — true when
   * `availMB` is already at/below `thresholdMB` at the moment of the call. */
  lowMemory: boolean;
};

const DeviceCpuModule = requireNativeModule<{
  getCoreCount(): number;
  getThermalStatus(): number;
  getMemoryInfo(): MemoryInfo;
  addListener(eventName: "onMemoryPressure", listener: (event: { level: number }) => void): { remove: () => void };
}>("DeviceCpu");

/** The device's real CPU core count (`Runtime.getRuntime().availableProcessors()`),
 * or `null` if the native call somehow fails — callers should fall back to a
 * conservative default rather than assume any particular device class. */
export function getCpuCoreCount(): number | null {
  try {
    const count = DeviceCpuModule.getCoreCount();
    return Number.isFinite(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * Mirrors Android's own `PowerManager.THERMAL_STATUS_*` constants (0 NONE
 * through 6 SHUTDOWN) — see `getThermalStatus()` below for how "unknown"
 * (pre-Android-10, or the call otherwise failing) is represented.
 */
export const ThermalStatus = {
  NONE: 0,
  LIGHT: 1,
  MODERATE: 2,
  SEVERE: 3,
  CRITICAL: 4,
  EMERGENCY: 5,
  SHUTDOWN: 6,
} as const;

/** Android's own real-time thermal signal (`PowerManager.getCurrentThermalStatus()`,
 * API 29+) — `null` on pre-Android-10 devices or if the native call somehow
 * fails, which callers must treat as "unknown," never as "definitely cool."
 * Used to let background AI work defer itself rather than pile more
 * sustained CPU load onto an already-hot chipset — general device hygiene,
 * not something tuned to any one device's thermal curve. */
export function getThermalStatus(): number | null {
  try {
    const status = DeviceCpuModule.getThermalStatus();
    return Number.isFinite(status) && status >= 0 ? status : null;
  } catch {
    return null;
  }
}

/**
 * Build 40: a one-shot, system-wide (not per-app) memory snapshot — see
 * services/ai/memoryGuard.ts for the actual "is it safe to start onboarding
 * right now" decision built on top of this. `null` on failure; callers must
 * treat that as "unknown," never "definitely fine," same contract as
 * `getThermalStatus` above.
 */
export function getMemoryInfo(): MemoryInfo | null {
  try {
    const info = DeviceCpuModule.getMemoryInfo();
    return info.availMB >= 0 ? info : null;
  } catch {
    return null;
  }
}

/**
 * Live low-memory early warning, fired while the SYSTEM overall is getting
 * tight — the window between "still fine" and "a process is about to get
 * killed," which a one-shot `getMemoryInfo()` call at the start of a long
 * operation can't see coming on its own. Returns an unsubscribe function;
 * safe to call even if the native listener registration itself fails
 * (swallowed, matching every other function here's "never throw into the
 * caller" contract) — in that case the returned function is a no-op.
 */
export function addMemoryPressureListener(onPressure: (level: number) => void): () => void {
  try {
    const subscription = DeviceCpuModule.addListener("onMemoryPressure", (event) => onPressure(event.level));
    return () => subscription.remove();
  } catch {
    return () => {};
  }
}
