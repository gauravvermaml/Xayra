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
const DeviceCpuModule = requireNativeModule<{
  getCoreCount(): number;
  getThermalStatus(): number;
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
