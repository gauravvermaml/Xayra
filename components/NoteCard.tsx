import { Pressable, StyleSheet, Text, View } from "react-native";

import { AudioPlayerControls } from "./AudioPlayerControls";

const colors = {
  surface: "#1e293b",
  border: "#334155",
  textPrimary: "#f8fafc",
  textMuted: "#94a3b8",
  danger: "#f87171",
};

export type NoteCardProps = {
  content: string;
  audioUri?: string | null;
  /** Reciprocal-rank-fusion score from hybrid search (higher = better); omitted for the plain notes list. */
  score?: number;
  /** Opens the full note detail (transcript, timestamp, audio, delete) — omit to disable tap-to-open. */
  onPress?: () => void;
  onDelete: () => void;
};

export function NoteCard({ content, audioUri, score, onPress, onDelete }: NoteCardProps) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={styles.card}>
      <Pressable
        onPress={onDelete}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={({ pressed }) => [styles.deleteButton, pressed && styles.deleteButtonPressed]}
      >
        <Text style={styles.deleteIcon}>🗑</Text>
      </Pressable>
      <Text style={styles.content}>{content}</Text>
      {score !== undefined && (
        <Text style={styles.distance}>match score {score.toFixed(3)}</Text>
      )}
      {!!audioUri && <AudioPlayerControls audioUri={audioUri} compact style={styles.player} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  content: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 21,
    paddingRight: 36,
  },
  distance: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 8,
  },
  player: {
    marginTop: 12,
    backgroundColor: "transparent",
    borderWidth: 0,
    padding: 0,
  },
  // High-contrast, deliberately larger than the rest of the card's touch
  // targets: a solid danger-red circle is easy to spot and easy to tap.
  deleteButton: {
    position: "absolute",
    top: 10,
    right: 10,
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
});
