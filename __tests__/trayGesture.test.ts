/**
 * Redmi uplift Stage 2: on the 50% tray a slow drag scrolls the
 * conversation and a quick upward fling opens the full-screen view.
 */

import { classifyListDrag, FLING_MAX_MS, FLING_SPEED, upwardReleaseSpeed } from "../utils/trayGesture";

const at = (offsetY: number, ms: number) => ({ offsetY, at: ms });

describe("upwardReleaseSpeed", () => {
  it("Android reports a finger-up release as negative y; iOS as positive", () => {
    expect(upwardReleaseSpeed(-1.75, "android")).toBe(1.75);
    expect(upwardReleaseSpeed(1.75, "ios")).toBe(1.75);
  });
});

describe("classifyListDrag", () => {
  it("a quick upward fling opens the full-screen view, even when the list can't move (short list or at its end)", () => {
    expect(classifyListDrag(at(87, 0), at(87, 90), 1.75)).toBe("flingUp");
    expect(classifyListDrag(at(0, 0), at(87, 110), 1.75)).toBe("flingUp");
  });

  it("content travelling fast upward counts even with a low reported velocity", () => {
    expect(classifyListDrag(at(400, 0), at(700, 200), 0)).toBe("flingUp");
  });

  it("a slow drag just scrolls — no expansion", () => {
    expect(classifyListDrag(at(0, 0), at(87, 1430), 0.13)).toBeNull();
    expect(classifyListDrag(at(0, 0), at(120, 300), 0.2)).toBeNull();
  });

  it("a long drag that only ends fast is still a scroll", () => {
    expect(classifyListDrag(at(0, 0), at(900, FLING_MAX_MS + 50), 3)).toBeNull();
  });

  it("a downward fling never expands", () => {
    expect(classifyListDrag(at(500, 0), at(100, 150), -2)).toBeNull();
    expect(classifyListDrag(at(0, 0), at(0, 94), -0.07)).toBeNull();
  });

  it("speed threshold is in dp per ms", () => {
    expect(FLING_SPEED).toBeGreaterThan(0.5);
    expect(classifyListDrag(at(0, 0), at(0, 100), FLING_SPEED - 0.01)).toBeNull();
    expect(classifyListDrag(at(0, 0), at(0, 100), FLING_SPEED)).toBe("flingUp");
  });
});
