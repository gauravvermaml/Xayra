/**
 * Xayra's design system. Every screen/component should pull colors, spacing,
 * radii, and typography from here rather than declaring its own local
 * `colors` object — keeps the whole app visually coherent and makes future
 * theme changes a one-file edit instead of a grep-and-replace across screens.
 */

export const colors = {
  // Base surfaces — charcoal/OLED slate, darkest to most elevated.
  background: "#0E0F12",
  surface: "#181920",
  surfaceElevated: "#1F212B",
  surfaceActive: "#242640",

  // Borders — subtle by design; contrast comes from surface layering, not
  // heavy outlines or drop shadows.
  border: "#2A2C38",
  borderStrong: "#383B4A",

  // Text hierarchy.
  textPrimary: "#F5F6FA",
  textSecondary: "#B4B8C6",
  textMuted: "#71758A",

  // Single vibrant accent — reserved for active states, primary actions,
  // and recording indicators. Everything else stays desaturated.
  accent: "#7C6CFF",
  accentMuted: "#3A3568",
  onAccent: "#FFFFFF",
  // Secondary brand glow — used only for the Xayra emblem's neon aura pulse
  // (paired with `accent`), never as a general-purpose UI color.
  accentCyan: "#4DF0FF",

  // Status colors — used sparingly (connection dots, destructive actions).
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",
  dangerMuted: "#3A2430",
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
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const typography = {
  title: { fontSize: 28, fontWeight: "700" as const, letterSpacing: -0.3 },
  heading: { fontSize: 17, fontWeight: "700" as const },
  subheading: { fontSize: 14, fontWeight: "600" as const },
  body: { fontSize: 15, fontWeight: "400" as const, lineHeight: 21 },
  label: { fontSize: 13, fontWeight: "600" as const },
  caption: { fontSize: 12, fontWeight: "500" as const },
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
