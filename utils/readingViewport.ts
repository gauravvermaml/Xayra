/**
 * The reading viewport the tray's list gets at the 50% stage with the dock
 * shown, and whether the dock should yield there instead (Xayra 2.0 Stage
 * 4.1). All inputs are measured layout in dp; nothing assumes a screen size
 * or font scale.
 */
export type ReadingViewportInput = {
  /** The 50% stage's height (half the window). */
  halfHeight: number;
  handleHeight: number;
  /** The compose field row's measured height. */
  composeHeaderHeight: number;
  /** The sheet body's top margin between the field and the list. */
  bodyMarginTop: number;
  /** The dock's measured height (bottom inset included). */
  dockHeight: number;
};

/**
 * Below this, the dock yields at 50% (fades out as the tray rises, back at
 * rest). 160dp at 100% text shows a question plus a full two-line answer —
 * on a 411 x 914 phone the answer text ends 133dp into the list — and keeps
 * the dock on every 100% configuration measured, 360 x 760 with three-button
 * navigation included (170dp).
 */
export const MIN_READING_VIEWPORT_AT_HALF = 160;

export function readingViewportAtHalf(i: ReadingViewportInput): number {
  return i.halfHeight - i.handleHeight - i.composeHeaderHeight - i.bodyMarginTop - i.dockHeight;
}

export function dockYieldsAtHalf(i: ReadingViewportInput): boolean {
  return readingViewportAtHalf(i) < MIN_READING_VIEWPORT_AT_HALF;
}
