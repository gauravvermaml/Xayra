import Svg, { Circle, Path } from "react-native-svg";

import { xayraColors } from "../../constants/xayraTheme";

export type OrbitProps = {
  /** Outer size in dp. The rings are drawn proportionally inside it. */
  size: number;
  /** Fewer rings for tight layouts (the responsive tiers use this later). */
  detail?: "full" | "reduced";
};

/**
 * The restrained Halo + Orbit rings: one hairline ring, one dotted ring and a
 * single lilac arc with its leading point. Static — motion (and its
 * reduced-motion fallback) belongs to the emblem component that hosts it.
 * Decorative, so it's hidden from accessibility services.
 */
export function Orbit({ size, detail = "full" }: OrbitProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 390 390" accessible={false} importantForAccessibility="no-hide-descendants">
      <Circle cx={195} cy={195} r={124} fill="none" stroke={xayraColors.orbit} strokeWidth={1.4} />
      {detail === "full" ? (
        <Circle cx={195} cy={195} r={150} fill="none" stroke={xayraColors.orbit} strokeWidth={1.4} strokeDasharray="1 7" strokeLinecap="round" />
      ) : null}
      <Path d="M270 65.1 A150 150 0 0 1 342.7 221" fill="none" stroke={xayraColors.lilac} strokeOpacity={0.5} strokeWidth={1.4} strokeLinecap="round" />
      <Circle cx={342.7} cy={221} r={2.8} fill={xayraColors.lilac} fillOpacity={0.85} />
    </Svg>
  );
}
