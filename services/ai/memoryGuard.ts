import { addMemoryPressureListener, getMemoryInfo, MemoryPressureLevel } from "expo-device-cpu";

/**
 * Build 40 — the three-layer defense against onboarding getting silently
 * killed by Android's own low-memory killer (LMKD), confirmed on-device: a
 * Pixel 9 with ordinary background apps open (Facebook, Messenger,
 * Instagram, LinkedIn — a realistic phone, not an edge case) had this app's
 * process reaped mid-onboarding, which looked to the user like the setup
 * screen simply freezing forever.
 *
 * Important limit, stated plainly: nothing here, or anywhere, can PREVENT
 * that kill. Deciding which process to close when the system needs memory
 * is the OS's own call — there is no app-level API that grants immunity.
 * What these two functions actually do is narrow the gap between "silently
 * killed with zero warning" and "the user was told what was happening and
 * given a chance to help" — a pre-flight check before starting the risky
 * stretch, and a live early-warning signal while it's running. A third,
 * separate layer (a "the last attempt didn't survive, don't gamble again"
 * fallback in modelDownloadManager.ts's `runOnboardingThreadCalibration`,
 * plus a visible timeout escape hatch in OnboardingSetupScreen.tsx) is what
 * guarantees the user is never left with nothing to do even if a kill still
 * happens despite both of these.
 */

/** Shown to the user verbatim — kept in one place so the pre-flight check
 * and the live mid-setup warning always say exactly the same thing. */
export const LOW_MEMORY_WARNING_MESSAGE =
  "Your phone is low on free memory right now. Closing a few background apps before continuing will make setup much more reliable.";

export type MemoryCheckResult = { safe: true } | { safe: false; message: string };

/**
 * Layer 1 — the pre-flight check, run once before onboarding's heavy
 * model-loading/calibration work starts. Mirrors the same pattern as an OS
 * "not enough storage to continue" dialog, applied to RAM instead of disk —
 * see this app's own design discussion for why the two need different
 * handling (storage is stable; free memory is a live, constantly shifting
 * number across every app on the phone, so this check is a real signal at
 * the moment it's taken, not a guarantee for the next several minutes).
 * `null` from the native call (unsupported/unknown) is treated as "safe" —
 * an unknown reading is not the same as a bad one, and this check must
 * never block onboarding outright just because it couldn't get an answer.
 */
export function checkMemoryBeforeOnboarding(): MemoryCheckResult {
  const info = getMemoryInfo();
  if (!info || !info.lowMemory) {
    return { safe: true };
  }
  return { safe: false, message: LOW_MEMORY_WARNING_MESSAGE };
}

/**
 * Layer 2 — live monitoring for the entire duration of onboarding's
 * completion sequence, not just a single check at the start. Android
 * reports `TRIM_MEMORY_RUNNING_LOW`/`_CRITICAL` to a still-foregrounded app
 * BEFORE it starts killing background processes for room — the actual
 * early-warning window a one-shot check can't see coming. Returns an
 * unsubscribe function; always call it once onboarding finishes or this
 * screen unmounts.
 */
export function watchForMemoryPressure(onPressure: () => void): () => void {
  return addMemoryPressureListener((level) => {
    if (level >= MemoryPressureLevel.RUNNING_LOW) {
      onPressure();
    }
  });
}
