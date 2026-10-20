/** Xayra 2.0 Stage 4: the emblem's responsive priority. */
import { emblemFit } from "../utils/emblemLayout";

const base = {
  cueHeight: 30,
  maxZone: 248,
  minZone: 64,
  reduceOrbitBelow: 132,
  dropCueBelow: 96,
  orbitRoom: 1.22,
  reducedOrbitRoom: 1.12,
};

describe("emblemFit", () => {
  it("plenty of room: full orbit and cue, capped at the stage maximum", () => {
    expect(emblemFit({ ...base, available: 600 })).toEqual({ zone: 248, tier: { orbit: "full", cue: true, hidden: false } });
  });
  it("1. reduces the decorative orbit first", () => {
    const r = emblemFit({ ...base, available: 170 }); // (170-30)/1.22 = 114.8 < 132
    expect(r.tier).toEqual({ orbit: "reduced", cue: true, hidden: false });
    expect(r.zone).toBeCloseTo(140 / 1.12, 5);
  });
  it("2. then drops the optional cue", () => {
    const r = emblemFit({ ...base, available: 120 }); // (120-30)/1.12 = 80 < 96
    expect(r.tier).toEqual({ orbit: "reduced", cue: false, hidden: false });
    expect(r.zone).toBeCloseTo(120 / 1.12, 5);
  });
  it("3. then shrinks the emblem toward its minimum", () => {
    const r = emblemFit({ ...base, available: 72 });
    expect(r.tier.hidden).toBe(false);
    expect(r.zone).toBeGreaterThanOrEqual(64);
  });
  it("4. hides only when even the minimum can't fit", () => {
    expect(emblemFit({ ...base, available: 60 })).toEqual({ zone: 0, tier: { orbit: "reduced", cue: false, hidden: true } });
  });
  it("never exceeds the width cap passed as maxZone", () => {
    expect(emblemFit({ ...base, maxZone: 241, available: 900 }).zone).toBe(241);
  });
});
