import { useCallback, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { leaveDisposableModeOnNextStart } from "../services/dev/disposableVault";

/**
 * Permanent warning shown on every screen while a Xayra Dev disposable test
 * vault is open (app/_layout.tsx). Also the way out: it stays reachable even
 * on the splash, locked or onboarding screens, where the Dev screen isn't.
 */
export function DisposableVaultBanner() {
  const insets = useSafeAreaInsets();
  const [leaving, setLeaving] = useState(false);

  const confirmLeave = useCallback(() => {
    Alert.alert(
      "Leave the disposable test vault?",
      "The test vault and everything in it is erased. Your normal Xayra Dev vault, its key and its reminders were never touched.",
      [
        { text: "Stay", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: () => {
            void leaveDisposableModeOnNextStart()
              .then(() => {
                setLeaving(true);
                Alert.alert("Restart to finish", "Close Xayra Dev from Recents and reopen it to return to your normal vault.");
              })
              .catch((err: unknown) => {
                Alert.alert("Couldn't leave the test vault", err instanceof Error ? err.message : String(err));
              });
          },
        },
      ]
    );
  }, []);

  return (
    <View pointerEvents="box-none" style={[styles.wrapper, { top: insets.top + 4 }]}>
      <View style={styles.banner} accessibilityRole="alert">
        <Text style={styles.text}>
          {leaving
            ? "Restart to return to your vault"
            : "Test vault · erased on restart"}
        </Text>
        {leaving ? null : (
          <Pressable onPress={confirmLeave} accessibilityRole="button" hitSlop={8} style={styles.exit}>
            <Text style={styles.exitLabel}>Leave</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // A centred chip that stays clear of the left and right ends of a header,
  // where screens keep their buttons (close, add, settings) — it overlays
  // only title space, never a control.
  wrapper: {
    position: "absolute",
    left: "20%",
    right: "20%",
    alignItems: "center",
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: 16,
    backgroundColor: "#7F1D1D",
  },
  text: {
    flexShrink: 1,
    color: "#FEE2E2",
    fontSize: 12,
    fontWeight: "600",
  },
  exit: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "#FEE2E2",
  },
  exitLabel: {
    color: "#7F1D1D",
    fontSize: 12,
    fontWeight: "700",
  },
});
