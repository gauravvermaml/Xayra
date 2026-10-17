/**
 * Xayra 2.0 "Quiet Intelligence" design tokens — Palette A (Soft Slate +
 * Cool Lilac) on true black, Plus Jakarta Sans + DM Sans. The visual spec is
 * the design canvas's rows P and Q.
 *
 * Deliberately a separate module from `constants/theme.ts`: Stage 1 adds the
 * new system without changing a single existing screen, so nothing that
 * imports the old theme sees a different value. Screens move onto these
 * tokens one at a time in later stages.
 */
import type { TextStyle } from "react-native";

export const xayraColors = {
  /** Main background — genuine jet black. */
  background: "#000000",
  /** Reading tray. */
  surface: "#111215",
  /** Compose field, segmented-control track. */
  field: "#1B1D21",
  /** Bottom dock panel. */
  dock: "#16181C",
  /** Selected segment fill. */
  raised: "#3A3E46",

  text: "#ECEDF1",
  textSoft: "#C9CBD3",
  textMuted: "#A0A3AD",
  textFaint: "#8A8D97",
  dockText: "#D5D7DE",

  /** Hairlines between quiet surfaces (decorative — never the only cue). */
  line: "rgba(225,228,236,0.10)",
  lineStrong: "rgba(225,228,236,0.16)",
  /** Secondary-button outline (Listen). */
  outline: "rgba(225,228,236,0.20)",
  /** Tray drag handle — 3.9:1 on the tray surface. */
  handle: "rgba(225,228,236,0.46)",

  lilac: "#BDB3EA",
  lilacText: "#CFC7F2",
  lilacSoft: "rgba(189,179,234,0.13)",
  /** Selected-segment ring — 4.8:1 against the track. */
  lilacRing: "rgba(189,179,234,0.60)",
  badge: "rgba(189,179,234,0.20)",
  badgeText: "#EDE9FC",

  teal: "#8FD6CF",
  tealSoft: "rgba(143,214,207,0.14)",
  tealRing: "rgba(143,214,207,0.45)",

  orbit: "rgba(205,200,236,0.12)",
  orbitFaint: "rgba(205,200,236,0.05)",
  emblemGlow: "rgba(150,132,232,0.30)",
} as const;

export type XayraColor = keyof typeof xayraColors;

/** Android font families registered by the expo-font config plugin
 * (app.json → android.fonts). Weights map to the bundled static files. */
export const xayraFonts = {
  display: "PlusJakartaSans",
  ui: "DMSans",
} as const;

type TypeToken = Required<Pick<TextStyle, "fontFamily" | "fontSize" | "fontWeight">> &
  Pick<TextStyle, "lineHeight" | "letterSpacing">;

/**
 * The approved hierarchy (dp). Sentence case everywhere, no added tracking
 * except the wordmark's slight tightening, nothing lighter than 400.
 */
export const xayraType = {
  wordmark: { fontFamily: xayraFonts.display, fontSize: 24, fontWeight: "700", letterSpacing: -0.24 },
  guidance: { fontFamily: xayraFonts.ui, fontSize: 15, lineHeight: 22, fontWeight: "400" },
  cue: { fontFamily: xayraFonts.ui, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  segment: { fontFamily: xayraFonts.display, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  segmentInactive: { fontFamily: xayraFonts.display, fontSize: 15, lineHeight: 20, fontWeight: "500" },
  input: { fontFamily: xayraFonts.ui, fontSize: 16, lineHeight: 22, fontWeight: "400" },
  roleLabel: { fontFamily: xayraFonts.ui, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  question: { fontFamily: xayraFonts.ui, fontSize: 15, lineHeight: 22, fontWeight: "400" },
  answer: { fontFamily: xayraFonts.ui, fontSize: 17, lineHeight: 26, fontWeight: "400" },
  chip: { fontFamily: xayraFonts.ui, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  dock: { fontFamily: xayraFonts.ui, fontSize: 14.5, lineHeight: 20, fontWeight: "500" },
  badge: { fontFamily: xayraFonts.ui, fontSize: 12.5, lineHeight: 16, fontWeight: "600" },
  meta: { fontFamily: xayraFonts.ui, fontSize: 13, lineHeight: 18, fontWeight: "400" },
} as const satisfies Record<string, TypeToken>;

export type XayraTypeVariant = keyof typeof xayraType;

/** Space between paragraphs of an answer. */
export const ANSWER_PARAGRAPH_GAP = 12;

export const xayraRadius = {
  key: 7,
  card: 18,
  dock: 22,
  field: 27,
  pill: 999,
} as const;

/** Minimum effective touch target for interactive controls (dp). */
export const MIN_TOUCH_TARGET = 48;

/** Brand elements (the wordmark) may stop growing at this system font
 * scale; functional text is never capped. */
export const BRAND_MAX_FONT_SCALE = 1.15;
