import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { colors, radius, spacing, typography } from "../constants/theme";
import { MIN_TOUCH_TARGET, xayraColors, xayraRadius, xayraType } from "../constants/xayraTheme";
import { copyTextWithFeedback } from "../utils/clipboard";
import { AudioPlayerControls } from "./AudioPlayerControls";

export type NoteCardProps = {
  content: string;
  audioUri?: string | null;
  /** Unix seconds; renders as a relative/short timestamp badge when present. */
  createdAt?: number;
  /** Reciprocal-rank-fusion score from hybrid search (higher = better); omitted for the plain notes list. */
  score?: number;
  /** Opens the full note detail (transcript, timestamp, audio, delete) — omit to disable tap-to-open. */
  onPress?: () => void;
  onDelete: () => void;
  /** `xayra`: the 2.0 home tray card (quiet slate card, icon delete).
   * `classic` (default): the original card — no screen uses it since
   * Archive moved to `xayra` (Redmi uplift Stage 4). */
  appearance?: "classic" | "xayra";
};

function formatTimestamp(createdAtUnixSeconds: number): string {
  const date = new Date(createdAtUnixSeconds * 1000);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function NoteCard({
  content,
  audioUri,
  createdAt,
  score,
  onPress,
  onDelete,
  appearance = "classic",
}: NoteCardProps) {
  if (appearance === "xayra") {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={() => void copyTextWithFeedback(content)}
        disabled={!onPress}
        accessibilityRole="button"
        accessibilityHint="Opens the note. Long-press to copy."
        style={({ pressed }) => [x.card, pressed && onPress && x.cardPressed]}
      >
        <View style={x.metaRow}>
          {createdAt !== undefined ? (
            <Text testID="note-card-date" style={x.metaText}>
              {formatTimestamp(createdAt)}
            </Text>
          ) : (
            <View />
          )}
          <Pressable
            testID="note-card-delete"
            onPress={onDelete}
            hitSlop={(MIN_TOUCH_TARGET - DELETE_SIZE) / 2}
            accessibilityRole="button"
            accessibilityLabel="Delete note"
            style={({ pressed }) => [x.deleteButton, pressed && x.deletePressed]}
          >
            <Feather name="trash-2" size={17} color={xayraColors.textMuted} />
          </Pressable>
        </View>
        <Text style={x.content} numberOfLines={6}>
          {content}
        </Text>
        {score !== undefined && <Text style={x.metaText}>match score {score.toFixed(3)}</Text>}
        {!!audioUri && <AudioPlayerControls audioUri={audioUri} compact style={styles.player} />}
        <View pointerEvents="none" style={x.copyHint}>
          <Feather name="copy" size={13} color={xayraColors.textFaint} />
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      // Long-press copies the note body without needing to open the detail
      // sheet first — a much faster path than tap-to-open > select-text for
      // the common "just grab this text" case.
      onLongPress={() => void copyTextWithFeedback(content)}
      disabled={!onPress}
      style={({ pressed }) => [styles.card, pressed && onPress && styles.cardPressed]}
    >
      <Pressable
        onPress={onDelete}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={({ pressed }) => [styles.deleteButton, pressed && styles.deleteButtonPressed]}
      >
        <Text style={styles.deleteIcon}>🗑</Text>
      </Pressable>

      {/* No "#Text"/"#Voice" tag: voice and typed Record both produce a text
          journal entry, so the input method carries no information. */}
      {createdAt !== undefined && (
        <View style={styles.metaRow}>
          <Text testID="note-card-date" style={styles.metaText}>
            {formatTimestamp(createdAt)}
          </Text>
        </View>
      )}

      {/* Build 22: `selectable` removed — inside a BottomSheetFlatList, RN's
          text-selection long-press gesture competes with the sheet/list's
          own scroll gesture, so a drag that starts on a card's text could be
          captured as a text-selection handle drag instead of a scroll. */}
      <Text style={styles.content} numberOfLines={6}>
        {content}
      </Text>

      {score !== undefined && (
        <Text style={styles.distance}>match score {score.toFixed(3)}</Text>
      )}

      {!!audioUri && <AudioPlayerControls audioUri={audioUri} compact style={styles.player} />}

      {/* A quiet, always-present affordance for the long-press-to-copy
          gesture above — not interactive itself (a real Pressable here would
          fight the card's own onLongPress for the gesture), just a visual
          hint that this card's text can be grabbed. */}
      <View pointerEvents="none" style={styles.copyHint}>
        <Text style={styles.copyHintIcon}>⧉</Text>
      </View>
    </Pressable>
  );
}

const DELETE_SIZE = 36;

/** Xayra 2.0 card: one step lighter than the tray, no border, no shadow. */
const x = StyleSheet.create({
  card: {
    backgroundColor: "#191B1F",
    borderRadius: xayraRadius.card,
    paddingTop: 8,
    paddingBottom: 16,
    paddingLeft: 16,
    paddingRight: 8,
    marginBottom: 10,
  },
  cardPressed: {
    backgroundColor: "#202227",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: DELETE_SIZE,
  },
  metaText: {
    ...xayraType.meta,
    color: xayraColors.textFaint,
  },
  content: {
    ...xayraType.question,
    color: xayraColors.text,
    paddingRight: 8,
  },
  deleteButton: {
    width: DELETE_SIZE,
    height: DELETE_SIZE,
    borderRadius: DELETE_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  deletePressed: {
    backgroundColor: xayraColors.line,
  },
  copyHint: {
    position: "absolute",
    bottom: 10,
    right: 12,
  },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardPressed: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
  },
  // Keeps clear of the absolutely positioned delete button (top-right).
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
    paddingRight: 36,
  },
  metaText: {
    color: colors.textMuted,
    ...typography.caption,
  },
  content: {
    color: colors.textPrimary,
    ...typography.body,
  },
  distance: {
    color: colors.textMuted,
    ...typography.caption,
    marginTop: spacing.sm,
  },
  player: {
    marginTop: spacing.md,
    backgroundColor: "transparent",
    borderWidth: 0,
    padding: 0,
  },
  // High-contrast, deliberately larger than the rest of the card's touch
  // targets: a solid danger-red circle is easy to spot and easy to tap.
  deleteButton: {
    position: "absolute",
    top: spacing.sm + 2,
    right: spacing.sm + 2,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  deleteButtonPressed: {
    opacity: 0.7,
  },
  deleteIcon: {
    fontSize: 15,
  },
  copyHint: {
    position: "absolute",
    bottom: spacing.sm,
    right: spacing.sm,
    opacity: 0.35,
  },
  copyHintIcon: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
