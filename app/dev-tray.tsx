/**
 * STAGE 2 SPIKE ONLY — selects the tray/dock variant for the next launch
 * (`xayra-devtest://dev-tray?v=A`). Development packages only.
 */
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";

import { isDevelopmentBuild } from "../services/ai/perf";
import { isTrayVariant, writeTrayVariant } from "../services/dev/trayVariant";

export default function DevTray() {
  const { v } = useLocalSearchParams<{ v?: string }>();
  const [message, setMessage] = useState("…");

  useEffect(() => {
    if (!isDevelopmentBuild()) {
      setMessage("Only available in development builds.");
      return;
    }
    if (!isTrayVariant(v)) {
      setMessage("Use ?v=control, A, A2 or B.");
      return;
    }
    void writeTrayVariant(v).then(() => setMessage(`Tray variant ${v} saved. Restart the app.`));
  }, [v]);

  return (
    <View style={styles.screen}>
      <Text style={styles.text} testID="dev-tray-message">
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000", alignItems: "center", justifyContent: "center", padding: 24 },
  text: { color: "#ECEDF1", fontSize: 16, textAlign: "center" },
});
