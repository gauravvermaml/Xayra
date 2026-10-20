import { StyleSheet, View } from "react-native";

import { CancelProcessingButton } from "./CancelProcessingButton";
import type { UtteranceMode } from "../services/audio/manualUtterance";

/**
 * The controls under the emblem while a manual recording is capturing
 * (Xayra 2.0 Stage 5a): Cancel always; Finish only when the emblem — the
 * normal Finish — is hidden because it can't fit on a constrained screen.
 * Finish is the filled primary, Cancel the outline secondary.
 */
export function RecordingActions({
  mode,
  showFinish,
  onFinish,
  onCancel,
}: {
  mode: UtteranceMode | null;
  showFinish: boolean;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const isAsk = mode === "ask";
  return (
    <View style={styles.row}>
      {showFinish && (
        <CancelProcessingButton
          testID="finish-recording"
          label="Finish"
          tone="filled"
          accessibilityLabel={
            isAsk ? "Finish question. Stops listening and asks it." : "Finish recording. Stops listening and saves the note."
          }
          onCancel={onFinish}
        />
      )}
      <CancelProcessingButton
        testID="cancel-recording"
        accessibilityLabel={
          isAsk ? "Cancel question. Stops listening without asking." : "Cancel recording. Stops listening without saving."
        }
        onCancel={onCancel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
  },
});
