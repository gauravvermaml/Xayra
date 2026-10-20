/**
 * Tray list gestures (Redmi uplift Stage 2): on the 50% tray a slow drag
 * scrolls the conversation and a quick upward fling opens the full-screen
 * view. (A downward drag at the top of the list needs nothing here: gorhom
 * already hands it to the sheet, which settles to rest.)
 */

/** A drag released faster than this (dp per ms) is a fling, not a scroll. */
export const FLING_SPEED = 1.1;
/** …and only a short one counts (a long, slow drag that ends fast doesn't). */
export const FLING_MAX_MS = 350;

export type DragSample = { offsetY: number; at: number };

/** The list's release velocity as finger-upward speed (dp per ms). Android
 * reports a finger-up release as NEGATIVE y (measured on the emulator: -1.75
 * for a quick upward swipe), iOS as positive. */
export function upwardReleaseSpeed(velocityY: number, os: string): number {
  return os === "android" ? -velocityY : velocityY;
}

/** Classifies one finished drag on the list. The release velocity is the
 * main signal — it is reported even when the list can't move (a short list,
 * or already at its end); the content's own travel is the fallback. */
export function classifyListDrag(start: DragSample, end: DragSample, upwardSpeed: number): "flingUp" | null {
  const ms = Math.max(1, end.at - start.at);
  if (ms > FLING_MAX_MS) return null;
  if (upwardSpeed >= FLING_SPEED) return "flingUp";
  const moved = end.offsetY - start.offsetY;
  if (moved > 0 && moved / ms >= FLING_SPEED) return "flingUp";
  return null;
}
