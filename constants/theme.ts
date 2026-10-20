/**
 * Xayra's design system. Every screen/component should pull colors, spacing,
 * radii, and typography from here rather than declaring its own local
 * `colors` object — keeps the whole app visually coherent and makes future
 * theme changes a one-file edit instead of a grep-and-replace across screens.
 */

import { xayraColors, xayraFonts } from "./xayraTheme";

export const colors = {
  // Redmi uplift Stage 4: the legacy names now carry the Xayra 2.0 values
  // (constants/xayraTheme.ts — Soft Slate + Cool Lilac on true black), so
  // every screen still on this module (To-Dos/Calendar, Archive, Settings,
  // the note screen, onboarding, recovery flows) reads as the same product
  // as Home. Names unchanged: no call site had to move.
  background: xayraColors.background,
  surface: xayraColors.surface,
  surfaceElevated: xayraColors.field,
  surfaceActive: "#24222F",

  border: xayraColors.line,
  borderStrong: xayraColors.lineStrong,

  // Text hierarchy.
  textPrimary: xayraColors.text,
  textSecondary: xayraColors.textSoft,
  textMuted: xayraColors.textMuted,

  // The single accent is Xayra 2.0's lilac. It is light, so content drawn
  // ON an accent fill (onAccent) is dark — white on lilac would be ~1.6:1.
  accent: xayraColors.lilac,
  accentMuted: "#2C2840",
  onAccent: "#17151F",
  // Secondary brand glow — the emblem's aura only.
  accentCyan: "#4DF0FF",

  // Status colors — used sparingly (connection dots, overdue, destructive
  // actions); never the only cue.
  success: "#7FD3A8",
  warning: "#F1C66B",
  danger: "#F2A5A5",
  dangerMuted: "#3A2228",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 22,
  pill: 999,
} as const;

// Xayra 2.0 families: Plus Jakarta Sans for titles and headings, DM Sans for
// everything read (the weights bundled in app.json).
export const typography = {
  title: { fontFamily: xayraFonts.display, fontSize: 26, fontWeight: "700" as const, letterSpacing: -0.26 },
  heading: { fontFamily: xayraFonts.display, fontSize: 17, fontWeight: "600" as const },
  subheading: { fontFamily: xayraFonts.ui, fontSize: 14, fontWeight: "600" as const },
  body: { fontFamily: xayraFonts.ui, fontSize: 15, fontWeight: "400" as const, lineHeight: 22 },
  label: { fontFamily: xayraFonts.ui, fontSize: 13, fontWeight: "600" as const },
  caption: { fontFamily: xayraFonts.ui, fontSize: 12, fontWeight: "500" as const },
};

/** Barely-there elevation — a soft, low-opacity shadow rather than the
 * default RN drop shadow, matching the "subtle border over heavy shadow"
 * design language across the app. */
export const elevation = {
  card: {
    shadowColor: "#000000",
    shadowOpacity: 0.24,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  floating: {
    shadowColor: colors.accent,
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
};

export const theme = { colors, spacing, radius, typography, elevation };
