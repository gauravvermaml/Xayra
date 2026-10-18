/**
 * Xayra 2.0 Stage 4.1: the dock yields at 50% only when the measured reading
 * viewport would fall below the minimum. Inputs are the emulator's measured
 * values (dp): field row 48 at 100 % (51 at 130 %, 61 at 200 %, wrapped
 * placeholder 88), handle 20, body margin 16.
 */
import { dockYieldsAtHalf, MIN_READING_VIEWPORT_AT_HALF, readingViewportAtHalf } from "../utils/readingViewport";

const at = (halfHeight: number, composeHeaderHeight: number, dockHeight: number) => ({
  halfHeight,
  handleHeight: 20,
  composeHeaderHeight,
  bodyMarginTop: 16,
  dockHeight,
});

describe("reading viewport at 50%", () => {
  it("is the 50% height minus handle, field row, body margin and dock", () => {
    expect(readingViewportAtHalf(at(457.1, 48, 99.8))).toBeCloseTo(273.3, 1);
  });

  it.each([
    ["411 x 914, gesture, 100 %", at(457.1, 48, 99.8)],
    ["411 x 914, gesture, 200 %", at(457.1, 61, 155.8)],
    ["411 x 914, three-button, 100 %", at(457.1, 48, 123.8)],
    ["411 x 914, three-button, 200 %", at(457.1, 61, 179.8)],
    ["360 x 760, gesture, 100 %", at(380, 48, 99.8)],
    ["360 x 760, three-button, 100 %", at(380, 48, 123.8)],
  ])("keeps the dock: %s", (_label, input) => {
    expect(dockYieldsAtHalf(input)).toBe(false);
  });

  it.each([
    ["360 x 760, gesture, 130 % (two-row dock)", at(380, 51, 155.8)],
    ["360 x 760, gesture, 200 %", at(380, 88, 155.8)],
    ["360 x 760, three-button, 130 %", at(380, 51, 179.8)],
    ["360 x 760, three-button, 200 %", at(380, 88, 179.8)],
  ])("dock yields: %s", (_label, input) => {
    expect(dockYieldsAtHalf(input)).toBe(true);
  });

  it("uses 160dp as the minimum", () => {
    expect(MIN_READING_VIEWPORT_AT_HALF).toBe(160);
  });
});
