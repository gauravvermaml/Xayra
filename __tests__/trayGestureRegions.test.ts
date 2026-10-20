/**
 * Redmi uplift Stage 2 corrections — the approved gesture map and the home
 * layout's single geometry owner.
 */

import { isExpandOrigin, LIST_TOP_TOLERANCE, PULL_DECIDE_SLOP, pullDownDecision } from "../utils/trayGestureRegions";
import { fittedEmblemZone, liveTrayHeight } from "../utils/emblemLayout";

const HEADER = 72; // measured header (compose bar) height

describe("50% → 100%: who may open the full-screen view", () => {
  it("a drag on the handle may", () => {
    expect(isExpandOrigin("handle", 0, HEADER)).toBe(true);
  });

  it("a drag that begins on the compose bar (the header) may", () => {
    expect(isExpandOrigin("content", 10, HEADER)).toBe(true);
    expect(isExpandOrigin("content", HEADER, HEADER)).toBe(true);
  });

  it("a drag that begins in the notes list or an answer only scrolls", () => {
    expect(isExpandOrigin("content", HEADER + 1, HEADER)).toBe(false);
    expect(isExpandOrigin("content", 400, HEADER)).toBe(false);
  });
});

describe("full screen: scroll, then pull down at the top", () => {
  it("upward travel is a scroll — the pull-down gives way at once", () => {
    expect(pullDownDecision(-PULL_DECIDE_SLOP - 1, 0)).toBe("fail");
    expect(pullDownDecision(-40, 300)).toBe("fail");
  });

  it("downward travel with content above scrolls the list (waits)", () => {
    expect(pullDownDecision(40, 300)).toBe("wait");
  });

  it("downward travel once the list is at its top pulls the view down — even mid-drag", () => {
    expect(pullDownDecision(40, 0)).toBe("activate");
    expect(pullDownDecision(200, LIST_TOP_TOLERANCE)).toBe("activate");
  });

  it("a tap (no travel) never takes over", () => {
    expect(pullDownDecision(0, 0)).toBe("wait");
    expect(pullDownDecision(PULL_DECIDE_SLOP, 0)).toBe("wait");
  });
});

describe("home layout: one live owner for the tray's height", () => {
  it("uses the live sheet edge against the keyboard-down canvas", () => {
    expect(liveTrayHeight(200, 900, 450, 200)).toBe(450);
  });

  it("never reports less than the rest stage", () => {
    expect(liveTrayHeight(200, 900, 850, 200)).toBe(200);
  });

  it("falls back to the snap-point value until both are measured", () => {
    expect(liveTrayHeight(321, 0, 450, 200)).toBe(321);
    expect(liveTrayHeight(321, 900, 0, 200)).toBe(321);
  });

  it("the emblem never outgrows the space the tray actually leaves", () => {
    expect(fittedEmblemZone(100, 248, 700, 400, 30, 1.22)).toBeCloseTo((700 - 400 - 30) / 1.22);
    expect(fittedEmblemZone(100, 248, 300, 400, 30, 1.22)).toBe(0);
  });

  it("…and fills it up to the home size — no smaller ceiling at 50% (the thinking emblem)", () => {
    expect(fittedEmblemZone(100, 248, 900, 200, 30, 1.22)).toBe(248);
  });

  it("…and isn't left tiny when the tray sits lower than its stage", () => {
    // Was: the 50% stage size (≤168) even with the tray near rest.
    expect(fittedEmblemZone(100, 248, 700, 250, 30, 1.22)).toBeGreaterThan(168);
  });

  it("uses the fallback until the space is measured", () => {
    expect(fittedEmblemZone(123, 248, 0, 200, 30, 1.22)).toBe(123);
  });
});
