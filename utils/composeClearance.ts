/**
 * How tall the compose input may grow while the keyboard is open, so the
 * field never extends under it.
 *
 * Why this exists: with the keyboard open, the tray stays at 50% of the full
 * window — the window isn't resized under edge-to-edge, and the sheet's own
 * keyboard logic is deliberately off (`android_keyboardInputMode=
 * "adjustResize"`, see HistorySheet.tsx). So the field's position never
 * depends on the keyboard, and its normal maximum can reach past the
 * keyboard's top edge on shorter screens, larger text or taller keyboards.
 *
 * The cap is the input's own padding plus whole lines, never a fractional
 * line, so the line being typed is never half-hidden by the field's edge;
 * past the cap the input scrolls internally, exactly as it already does past
 * its normal maximum. It never goes below the input's measured one-line
 * height: when even that can't clear the keyboard, `fits` is false and the
 * field keeps its one-line size.
 *
 * All values are window coordinates / dp from real measurements; nothing is
 * derived from a hardcoded screen size.
 */
export type ComposeClearanceInput = {
  /** Keyboard's top edge (keyboard event `endCoordinates.screenY`). */
  keyboardTop: number;
  /** Top edge of the field's container (`measureInWindow`). The field grows
   * downward from here, so this doesn't move as lines are added. */
  containerTop: number;
  /** Vertical padding inside the container, above and below the input. */
  containerPadding: number;
  /** The container's minimum height (its one-line look). */
  containerMinHeight: number;
  /** Clearance kept between the field and the keyboard. */
  margin: number;
  /** One line of input text, after the system font scale. */
  lineHeight: number;
  /** The input's measured height showing one line (text plus the platform's
   * own vertical padding). */
  oneLineHeight: number;
  /** The normal line cap and height ceiling, used whenever there's room. */
  maxLines: number;
  maxHeight: number;
};

export type ComposeClearance = {
  lines: number;
  maxHeight: number;
  /** True when the cap is lower than the normal maximum. */
  constrained: boolean;
  /** False when even one line can't clear the keyboard. */
  fits: boolean;
};

export function composeClearance({
  keyboardTop,
  containerTop,
  containerPadding,
  containerMinHeight,
  margin,
  lineHeight,
  oneLineHeight,
  maxLines,
  maxHeight,
}: ComposeClearanceInput): ComposeClearance {
  const room = keyboardTop - containerTop - margin;
  const fits = room >= Math.max(containerMinHeight, oneLineHeight + 2 * containerPadding);
  if (!fits) return { lines: 1, maxHeight: oneLineHeight, constrained: true, fits: false };

  const inset = Math.max(0, oneLineHeight - lineHeight);
  const lines = Math.min(maxLines, Math.max(1, Math.floor((room - 2 * containerPadding - inset) / lineHeight)));
  const height = Math.min(maxHeight, inset + lines * lineHeight);
  if (height >= maxHeight) return { lines: maxLines, maxHeight, constrained: false, fits: true };
  return { lines, maxHeight: height, constrained: true, fits: true };
}
