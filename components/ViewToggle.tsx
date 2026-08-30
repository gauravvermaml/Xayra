import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "react-native";
import { useRouter } from "expo-router";

import { colors } from "../constants/theme";

export function ViewToggle({ active }: { active: "notes" | "chat" }) {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => router.replace("/")}
        style={[styles.segment, active === "notes" && styles.segmentActive]}
      >
        <Text style={[styles.label, active === "notes" && styles.labelActive]}>Notes</Text>
      </Pressable>
      <Pressable
        onPress={() => router.replace("/chat")}
        style={[styles.segment, active === "chat" && styles.segmentActive]}
      >
        <Text style={[styles.label, active === "chat" && styles.labelActive]}>Chat</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 4,
    marginBottom: 20,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: "center",
  },
  segmentActive: {
    backgroundColor: colors.accent,
  },
  label: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
  labelActive: {
    color: colors.onAccent,
  },
});
