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
