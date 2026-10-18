import { Pressable, StyleSheet, View } from "react-native";

import { xayraColors, xayraRadius } from "../../constants/xayraTheme";
import { XText } from "./XText";

export type Segment<K extends string> = { key: K; label: string };

export type SegmentedControlProps<K extends string> = {
  segments: readonly Segment<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Locked (e.g. Record/Ask while an utterance is in flight): visible but
   * not changeable, and announced as disabled. */
  disabled?: boolean;
  accessibilityLabel: string;
};

/**
 * The Record/Ask style switch. The selected segment is marked three ways —
 * lighter fill, a lilac ring (4.8:1 against the track) and a heavier weight —
 * so it doesn't rely on fill alone.
 */
export function SegmentedControl<K extends string>({
  segments,
  value,
  onChange,
  disabled = false,
  accessibilityLabel,
}: SegmentedControlProps<K>) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={styles.track}>
      {segments.map((segment) => {
        const selected = segment.key === value;
        return (
          <Pressable
            key={segment.key}
            accessibilityRole="radio"
            accessibilityLabel={segment.label}
            accessibilityState={{ selected, checked: selected, disabled }}
            disabled={disabled}
            // 42dp visible + 3dp above and below (the track's own padding)
            // = a 48dp touch target.
            hitSlop={{ top: 3, bottom: 3 }}
            onPress={() => onChange(segment.key)}
            // Locked: the selected mode stays fully readable (it's what the
            // in-flight utterance means); only the other one dims.
            style={[styles.segment, selected && styles.selected, disabled && !selected && styles.locked]}
          >
            <XText variant={selected ? "segment" : "segmentInactive"}>{segment.label}</XText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    alignSelf: "center",
    gap: 2,
    padding: 3,
    borderRadius: xayraRadius.pill,
    backgroundColor: xayraColors.field,
    borderWidth: 1,
    borderColor: xayraColors.line,
  },
  segment: {
    minWidth: 84,
    minHeight: 42,
    paddingHorizontal: 18,
    borderRadius: xayraRadius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  selected: {
    backgroundColor: xayraColors.raised,
    borderWidth: 1,
    borderColor: xayraColors.lilacRing,
  },
  locked: {
    opacity: 0.35,
  },
});
