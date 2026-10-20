import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";

import { colors, spacing, typography } from "../constants/theme";
import { isMicHarnessAvailable, runMicHarness } from "../services/dev/micHarness";

/**
 * Xayra Test-only harness for the native microphone session API (Gate A).
 * `xayra-devtest://dev-mic-harness?run=A1&nonce=<n>` runs one scenario and
 * logs `[MicHarness]` lines to logcat. In any other package it renders a
 * notice and does nothing.
 */
export default function DevMicHarnessScreen() {
  const { run, nonce } = useLocalSearchParams<{ run?: string; nonce?: string }>();
  const available = isMicHarnessAvailable();
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!available || !run) return;
    let alive = true;
    setLines([]);
    void runMicHarness(run, (event, detail) => {
      const line = `[MicHarness] ${run} ${event} ${detail ? JSON.stringify(detail) : ""}`;
      console.log(line);
      if (alive) setLines((prev) => [...prev, `${event} ${detail ? JSON.stringify(detail) : ""}`]);
    });
    return () => {
      alive = false;
    };
  }, [available, run, nonce]);

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>{available ? `Mic harness${run ? ` — ${run}` : ""}` : "Unavailable"}</Text>
      <ScrollView>
        {lines.map((line, i) => (
          <Text key={i} style={styles.line}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.sm },
  line: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.xs },
});
