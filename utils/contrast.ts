/**
 * WCAG 2.x contrast maths for design-token checks (tests only today).
 * Colours are "#rrggbb" or "rgba(r,g,b,a)"; a translucent colour is first
 * composited over the background it actually sits on.
 */
type Rgb = [number, number, number];

function parse(color: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color.trim());
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`Unsupported colour: ${color}`);
}

/** Composites `color` over the opaque `background`. */
export function composite(color: string, background: string): Rgb {
  const fg = parse(color);
  const bg = parse(background);
  if (bg.alpha !== 1) throw new Error("Background must be opaque");
  return fg.rgb.map((c, i) => c * fg.alpha + bg.rgb[i] * (1 - fg.alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio of `foreground` drawn on the opaque `background`. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(composite(foreground, background));
  const b = luminance(parse(background).rgb);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Solid colour (as rgb) of a translucent layer over a background, as "#rrggbb". */
export function flatten(color: string, background: string): string {
  return `#${composite(color, background)
    .map((c) => Math.round(c).toString(16).padStart(2, "0"))
    .join("")}`;
}
