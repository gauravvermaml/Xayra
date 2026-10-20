/**
 * Who owns a vertical drag on the tray (Redmi uplift Stage 2 corrections —
 * the approved gesture map):
 *
 *  - 50% tray: a drag that begins on the handle or the header (compose bar)
 *    drives the tray and can open the full-screen view; one that begins in
 *    the notes / conversation / answer list scrolls the list (and at the
 *    list's top, a downward pull settles the tray — gorhom's own handoff).
 *  - Full screen: the list scrolls; at its top, continued downward travel
 *    pulls the view back down.
 */

/** Finger travel (dp) before the full-screen pull-down decides. */
export const PULL_DECIDE_SLOP = 8;
/** The list counts as at its top within this offset (dp). */
export const LIST_TOP_TOLERANCE = 1;

/** Whether a sheet drag may open the full-screen view: the handle always;
 * a content drag only when it BEGAN within the header (`startY` is relative
 * to the sheet's content, whose top is the header). */
export function isExpandOrigin(source: "handle" | "content", startY: number, headerHeight: number): boolean {
  "worklet";
  return source === "handle" || startY <= headerHeight;
}

/** Full-screen pull-down: `dy` is finger travel since touch-down (down is
 * positive). Upward travel is a scroll — fail at once; downward travel takes
 * over only while the list is at its top (it may get there mid-drag). */
export function pullDownDecision(dy: number, listOffset: number): "activate" | "fail" | "wait" {
  "worklet";
  if (dy < -PULL_DECIDE_SLOP) return "fail";
  if (dy > PULL_DECIDE_SLOP && listOffset <= LIST_TOP_TOLERANCE) return "activate";
  return "wait";
}
