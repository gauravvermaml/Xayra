import { StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing } from "../constants/theme";
import type { ModelDownloadStatus } from "../services/ai/modelDownloadManager";

export type ModelDownloadCardProps = {
  modelDownload: ModelDownloadStatus;
};

/**
 * Build 25 MODEL DOWNLOAD CARD: the on-device setup progress indicator,
 * extracted out of ChatSheetContent.tsx (where it used to live, QA-tab-only)
 * into its own component so HistorySheet.tsx can render it once, beneath
 * whichever list ("Recorded notes" or "Searched notes") is currently
 * showing — setup is a whole-app concern, not something specific to asking
 * questions. Renders nothing at all outside the "downloading" state; the
 * cellular-blocked/error/paused-offline prompts (which carry their own
 * action buttons) stay in ChatSheetContent, since they're specifically about
 * the chat model gating the ASK pipeline.
 */
export function ModelDownloadCard({ modelDownload }: ModelDownloadCardProps) {
  if (modelDownload.status !== "downloading") {
    return null;
  }

  const percent = Math.round(modelDownload.progressPercent);

  return (
    <View style={styles.card}>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
      {/* TEXT FORMATTING: exact required format — "Downloading in
          progress... 58% of 100%". */}
      <Text style={styles.progressText}>{`Downloading in progress... ${percent}% of 100%`}</Text>
      <Text style={styles.subtitleText}>
        Setting up Xayra's intelligence. Once complete, you can start asking questions 100% offline.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // COMPACT STYLING: sleek, caption-scale card — noticeably smaller than the
  // old QA-only setup bar it replaces.
  card: {
    backgroundColor: "#1C1C1E",
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.base,
    marginBottom: spacing.sm,
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "#2C2C2E",
    overflow: "hidden",
    marginBottom: spacing.xs,
  },
  fill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  progressText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  subtitleText: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    marginTop: 2,
    opacity: 0.85,
  },
});
