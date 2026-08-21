import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing, typography } from "../constants/theme";
import { AudioPlayerControls } from "./AudioPlayerControls";

export type NoteCardProps = {
  content: string;
  audioUri?: string | null;
  /** Unix seconds; renders as a relative/short timestamp badge when present. */
  createdAt?: number;
  /** Reciprocal-rank-fusion score from hybrid search (higher = better); omitted for the plain notes list. */
  score?: number;
  /** Which local Whisper engine ("base" | "tiny") transcribed this note, if any. */
  transcriptionModel?: string | null;
  /** Opens the full note detail (transcript, timestamp, audio, delete) — omit to disable tap-to-open. */
  onPress?: () => void;
  onDelete: () => void;
  /** Called when the "switch engine" nudge on a Tiny-transcribed note is tapped. */
  onSwitchEngine?: () => void;
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
  transcriptionModel,
  onPress,
  onDelete,
  onSwitchEngine,
}: NoteCardProps) {
  return (
    <Pressable
      onPress={onPress}
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

      <View style={styles.tagRow}>
        <View style={styles.tagPill}>
          <Text style={styles.tagPillText}>{audioUri ? "#Voice" : "#Text"}</Text>
        </View>
        {createdAt !== undefined && (
          <Text style={styles.metaText}>{formatTimestamp(createdAt)}</Text>
        )}
      </View>

      <Text style={styles.content} numberOfLines={6}>
        {content}
      </Text>

      {score !== undefined && (
        <Text style={styles.distance}>match score {score.toFixed(3)}</Text>
      )}

      {!!audioUri && <AudioPlayerControls audioUri={audioUri} compact style={styles.player} />}

      {transcriptionModel === "tiny" && (
        <Pressable onPress={onSwitchEngine} disabled={!onSwitchEngine} hitSlop={6} style={styles.engineChip}>
          <Text style={styles.engineChipText}>
            Tiny Engine used · Tap to switch to Base Engine in Settings
          </Text>
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.base,
    marginBottom: spacing.md,
  },
  cardPressed: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
  },
  tagRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
    paddingRight: 36,
  },
  tagPill: {
    backgroundColor: colors.accentMuted,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  tagPillText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "700",
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
  engineChip: {
    alignSelf: "flex-start",
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  engineChipText: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "600",
  },
});
