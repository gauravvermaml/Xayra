import { StyleSheet, Text, View } from "react-native";

import { spacing } from "../constants/theme";
import { xayraColors, xayraRadius, xayraType } from "../constants/xayraTheme";
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
        Setting up Xayra's intelligence. Once complete, you can ask questions without an internet connection.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // COMPACT STYLING: sleek, caption-scale card — noticeably smaller than the
  // old QA-only setup bar it replaces. INLINE DOWNLOAD CARD FLOW (Build 26):
  // a plain flex child, same as its siblings above — nothing here is
  // position:"absolute". marginBottom/paddingBottom are explicit literal
  // values (not the usual spacing.* scale) so the card's own bottom edge
  // never sits flush against anything below it; HistorySheet.tsx additionally
  // wraps this in a `paddingBottom: bottomInset` View for genuine Android
  // nav-bar clearance (confirmed necessary on-device in Build 25 — this
  // fixed margin alone isn't tall enough for a 3-button nav bar).
  card: {
    backgroundColor: xayraColors.field,
    borderRadius: xayraRadius.card,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
    paddingBottom: spacing.base,
    marginHorizontal: spacing.base,
    // Sits directly above the dock now (HistorySheet pads the body by the
    // dock's measured height), so only a small gap is needed.
    marginBottom: spacing.md,
    gap: 6,
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: xayraColors.lineStrong,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    backgroundColor: xayraColors.lilac,
    borderRadius: 2,
  },
  progressText: {
    ...xayraType.chip,
    color: xayraColors.textSoft,
    textAlign: "center",
  },
  subtitleText: {
    ...xayraType.meta,
    color: xayraColors.textMuted,
    textAlign: "center",
  },

});
