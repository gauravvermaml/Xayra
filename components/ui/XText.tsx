import { Text, type TextProps } from "react-native";

import { BRAND_MAX_FONT_SCALE, xayraColors, xayraType, type XayraColor, type XayraTypeVariant } from "../../constants/xayraTheme";

export type XTextProps = TextProps & {
  variant: XayraTypeVariant;
  color?: XayraColor;
};

const DEFAULT_COLOR: Record<XayraTypeVariant, XayraColor> = {
  wordmark: "text",
  guidance: "textMuted",
  cue: "textMuted",
  segment: "text",
  segmentInactive: "textMuted",
  input: "text",
  roleLabel: "textFaint",
  question: "textSoft",
  answer: "text",
  chip: "lilacText",
  dock: "dockText",
  badge: "badgeText",
  meta: "textFaint",
};

/**
 * Text in the 2.0 type system. Follows the system font size like any other
 * Text — the only exception is the wordmark, a brand element that stops
 * growing at BRAND_MAX_FONT_SCALE. Callers' `style` still wins.
 */
export function XText({ variant, color, style, ...rest }: XTextProps) {
  const isBrand = variant === "wordmark";
  return (
    <Text
      {...rest}
      maxFontSizeMultiplier={isBrand ? BRAND_MAX_FONT_SCALE : rest.maxFontSizeMultiplier}
      style={[xayraType[variant], { color: xayraColors[color ?? DEFAULT_COLOR[variant]] }, style]}
    />
  );
}
