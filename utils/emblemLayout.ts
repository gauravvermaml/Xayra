/**
 * How the home emblem fits the space left between the header and the
 * Record/Ask switch at one tray stage — the approved responsive priority:
 *
 *  1. full emblem zone, full orbit and the "Tap to …" cue;
 *  2. reduce the purely decorative orbit (no dotted ring / teal arc), which
 *     needs less room around the zone;
 *  3. drop the optional cue;
 *  4. shrink the emblem down to its minimum;
 *  5. hide it only when even the minimum can't fit beside the essential
 *     controls (status line, waveform and Cancel while working).
 *
 * All values in dp, from measured layout (app/index.tsx).
 */
export type EmblemTier = { orbit: "full" | "reduced"; cue: boolean; hidden: boolean };

export const FULL_EMBLEM_TIER: EmblemTier = { orbit: "full", cue: true, hidden: false };

export type EmblemFitInput = {
  /** Height between the header and the switch at this stage, minus what
   * must always fit under the emblem (essential status / waveform / Cancel). */
  available: number;
  /** Height the optional cue takes (0 when it isn't shown anyway). */
  cueHeight: number;
  /** Largest zone for this stage (and the width cap). */
  maxZone: number;
  minZone: number;
  /** Zone size below which the orbit is reduced, then the cue dropped. */
  reduceOrbitBelow: number;
  dropCueBelow: number;
  /** Room kept around the zone for the full and the reduced orbit. */
  orbitRoom: number;
  reducedOrbitRoom: number;
};

export function emblemFit(i: EmblemFitInput): { zone: number; tier: EmblemTier } {
  const full = (i.available - i.cueHeight) / i.orbitRoom;
  if (full >= i.reduceOrbitBelow) return { zone: Math.min(i.maxZone, full), tier: FULL_EMBLEM_TIER };
  const reduced = (i.available - i.cueHeight) / i.reducedOrbitRoom;
  if (reduced >= i.dropCueBelow) {
    return { zone: Math.min(i.maxZone, reduced), tier: { orbit: "reduced", cue: true, hidden: false } };
  }
  const noCue = i.available / i.reducedOrbitRoom;
  if (noCue >= i.minZone) {
    return { zone: Math.min(i.maxZone, noCue), tier: { orbit: "reduced", cue: false, hidden: false } };
  }
  return { zone: 0, tier: { orbit: "reduced", cue: false, hidden: true } };
}

export const sameEmblemTier = (a: EmblemTier, b: EmblemTier) =>
  a.orbit === b.orbit && a.cue === b.cue && a.hidden === b.hidden;

/**
 * The tray's live height (Redmi uplift Stage 2 corrections): the canvas
 * (keyboard down) less the sheet's live top edge, never below the rest
 * stage. `staged` (the snap-point interpolation) stands in until both are
 * known.
 */
export function liveTrayHeight(staged: number, canvasHeight: number, sheetTop: number, restHeight: number): number {
  "worklet";
  if (canvasHeight <= 0 || sheetTop <= 0 || sheetTop >= canvasHeight) return staged;
  return Math.max(restHeight, canvasHeight - sheetTop);
}

/**
 * The emblem zone from the space the tray actually leaves (Redmi uplift
 * Stages 2–3): `base` is the room above the tray less the switch and the
 * essentials under the emblem. As large as that allows, up to the home
 * size — one rule at every tray position, so the thinking emblem at 50%
 * stays as close to the home emblem as the screen permits (there was a
 * separate, smaller 50% cap), and a tray off its snap point can neither
 * squeeze the emblem into the switch nor leave it tiny in empty space.
 * `fallback` stands in until the space is measured.
 */
export function fittedEmblemZone(
  fallback: number,
  maxZone: number,
  base: number,
  trayHeight: number,
  cue: number,
  room: number
): number {
  "worklet";
  if (base <= 0) return fallback;
  return Math.max(0, Math.min(maxZone, (base - trayHeight - cue) / room));
}
