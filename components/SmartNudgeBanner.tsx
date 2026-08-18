import { Pressable, StyleSheet, Text, View } from "react-native";

const colors = {
  surface: "#1e293b",
  surfaceAlt: "#27324a",
  border: "#334155",
  textPrimary: "#f8fafc",
  textMuted: "#94a3b8",
  accent: "#6366f1",
};

export type SmartNudgeBannerProps = {
  onConnect: () => void;
  onDismiss: () => void;
};

/**
 * Shown on the Notes tab once a vault has enough notes to be worth
 * protecting (>= 5) and isn't yet backed up anywhere. Purely a soft nudge —
 * dismissing it doesn't disable anything, and it reappears next session
 * since dismissal isn't persisted (the caller decides that; see
 * app/index.tsx for the actual >=5-and-not-connected gating logic).
 */
export function SmartNudgeBanner({ onConnect, onDismiss }: SmartNudgeBannerProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        Protect your private vault. Connect Google Drive for encrypted auto-backups.
      </Text>
      <View style={styles.actions}>
        <Pressable onPress={onConnect} style={styles.connectButton}>
          <Text style={styles.connectButtonText}>Connect</Text>
        </Pressable>
        <Pressable onPress={onDismiss} style={styles.dismissButton} hitSlop={8}>
          <Text style={styles.dismissButtonText}>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  text: {
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  connectButton: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  connectButtonText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  dismissButton: {
    paddingVertical: 8,
  },
  dismissButtonText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
});
