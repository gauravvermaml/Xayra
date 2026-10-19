/**
 * Xayra 2.0 design-system sandbox (Stage 1) — the approved tokens, fonts and
 * presentation components on one scrollable page, for checking native font
 * rendering, contrast and text scaling on a device. Reachable at
 * /design-system in development packages only (Xayra Dev / Xayra Test);
 * a production build shows a notice instead. Imports nothing from the home
 * screen and changes no app state.
 */
import { useState } from "react";
import { Image, PixelRatio, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { ANSWER_PARAGRAPH_GAP, xayraColors as c, xayraRadius, xayraType } from "../constants/xayraTheme";
import { XText } from "../components/ui/XText";
import { Chip } from "../components/ui/Chip";
import { IconButton } from "../components/ui/IconButton";
import { Pill } from "../components/ui/Pill";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Orbit } from "../components/ui/Orbit";
import { isDevelopmentBuild } from "../services/ai/perf";
import { useLocalSearchParams } from "expo-router";
import { HomeDock, type HandsfreeDisplayState } from "../components/HomeDock";
import { HandsfreeTypingStatus } from "../components/HandsfreeTypingStatus";
import type { ActiveModeState } from "../services/audio/activeMode";

/** Xayra 2.0 Stage 5b: the real dock and typing strip in each Handsfree
 * state, at this device's actual width and text scale — processing and
 * speaking can't be reached on an emulator without speech input. */
const HANDSFREE_PREVIEW_STATES: (HandsfreeDisplayState | "off")[] = [
  "off",
  "starting",
  "listening",
  "processing",
  "speaking",
  "stopFailed",
];

function HandsfreeStatesPreview({ topInset }: { topInset: number }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: topInset + 16 }]}>
      <XText variant="meta">Handsfree states · font scale {PixelRatio.getFontScale().toFixed(2)}</XText>
      {HANDSFREE_PREVIEW_STATES.map((state) => (
        <View key={state} style={styles.previewBlock}>
          <XText variant="roleLabel">{state}</XText>
          {/* Full screen width, like the real dock (the sandbox pads 20dp). */}
          <View style={styles.previewFullWidth}>
          <HomeDock
            handsfreeActive={state !== "off"}
            handsfreeState={state === "off" ? "idle" : state}
            pendingCount={2}
            bottomInset={0}
            onHandsfree={() => {}}
            onTodos={() => {}}
            onMore={() => {}}
            onHeightChange={() => {}}
          />
          </View>
          {state !== "off" && state !== "starting" && <HandsfreeTypingStatus state={state} onStop={() => {}} />}
        </View>
      ))}
    </ScrollView>
  );
}

type Mode = "record" | "ask";
const MODES = [
  { key: "record", label: "Record" },
  { key: "ask", label: "Ask" },
] as const;

export default function DesignSystemSandbox() {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>("record");
  const [handsfree, setHandsfree] = useState(false);
  const { section } = useLocalSearchParams<{ section?: string }>();

  if (!isDevelopmentBuild()) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.notice}>The design-system sandbox is only available in development builds.</Text>
      </View>
    );
  }

  if (section === "handsfree") {
    return <HandsfreeStatesPreview topInset={insets.top} />;
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }]}
    >
      <XText variant="meta">Design system · Stage 1 · font scale {PixelRatio.getFontScale().toFixed(2)}</XText>

      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Image source={require("../assets/icon.png")} style={styles.logo} />
          <XText variant="wordmark" accessibilityRole="header">
            Xayra
          </XText>
        </View>
        <XText variant="guidance" style={styles.centerText}>
          {mode === "record"
            ? "Speak or type a thought. Say “remind me…” to create a to-do."
            : "Ask Xayra about anything you’ve recorded."}
        </XText>
      </View>

      <View style={styles.emblemZone}>
        <View style={styles.orbit}>
          <Orbit size={300} />
        </View>
        <Image
          source={require("../assets/splash-icon-round.png")}
          style={styles.emblem}
          accessibilityLabel="Xayra emblem"
        />
      </View>
      <XText variant="cue" style={styles.centerText}>
        {mode === "record" ? "Tap to record" : "Tap to ask"}
      </XText>

      <SegmentedControl segments={MODES} value={mode} onChange={setMode} accessibilityLabel="Mode" />
      <SegmentedControl segments={MODES} value={mode} onChange={setMode} disabled accessibilityLabel="Mode, locked while recording" />

      <View style={styles.tray}>
        <View style={styles.handle} />
        <View style={styles.field}>
          <Feather name={mode === "record" ? "edit-3" : "search"} size={20} color={c.textMuted} />
          <XText variant="input" color="textFaint" style={styles.flex}>
            {mode === "record" ? "Type your thoughts…" : "Search your thoughts…"}
          </XText>
          <IconButton
            accessibilityLabel={mode === "record" ? "Save note" : "Ask"}
            tone="send"
            icon={<Feather name="arrow-up" size={19} color={c.teal} />}
            onPress={() => {}}
          />
        </View>

        <View style={styles.answer}>
          <XText variant="roleLabel">You</XText>
          <XText variant="question">What did I decide about the kitchen renovation?</XText>
          <XText variant="roleLabel" color="lilac" style={styles.gapTop}>
            Xayra
          </XText>
          <XText variant="answer">
            You chose the pale oak worktop over the white quartz. Your note from 28 September says the oak was about a
            third cheaper and felt warmer with the existing floor.
          </XText>
          <XText variant="answer">Sam, the builder, can start on Monday, 2 November.</XText>
          <View style={styles.row}>
            <Pill label="Listen" icon={<Feather name="volume-2" size={17} color={c.text} />} onPress={() => {}} />
            <Chip label="[Note 1]" onPress={() => {}} />
            <Chip label="[Note 2]" onPress={() => {}} />
          </View>
        </View>

        <View style={styles.dock}>
          <Pill
            label={handsfree ? "Handsfree · listening" : "Handsfree"}
            tone={handsfree ? "active" : "secondary"}
            icon={<Feather name="headphones" size={18} color={handsfree ? c.teal : c.text} />}
            accessibilityState={{ selected: handsfree }}
            onPress={() => setHandsfree((v) => !v)}
          />
          <Pill label="To-Dos 3" icon={<Feather name="check-circle" size={18} color={c.text} />} onPress={() => {}} />
          <Pill label="More" icon={<Feather name="more-horizontal" size={18} color={c.text} />} accessibilityRole="button" onPress={() => {}} />
        </View>
      </View>

      <View style={styles.scale}>
        <XText variant="meta">Type scale (dp)</XText>
        {Object.entries(xayraType).map(([name, token]) => (
          <View key={name} style={styles.scaleRow}>
            <XText variant={name as keyof typeof xayraType}>{name}</XText>
            <XText variant="meta">
              {token.fontFamily} {token.fontSize}
              {"lineHeight" in token ? `/${token.lineHeight}` : ""} · {token.fontWeight}
            </XText>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  previewBlock: {
    gap: 10,
  },
  previewFullWidth: {
    marginHorizontal: -20,
  },
  screen: { flex: 1, backgroundColor: c.background },
  center: { alignItems: "center", justifyContent: "center", padding: 24 },
  notice: { color: c.textMuted, fontSize: 15, textAlign: "center" },
  content: { paddingHorizontal: 20, gap: 20 },
  header: { alignItems: "center", gap: 8 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  logo: { width: 28, height: 28, borderRadius: 7 },
  centerText: { textAlign: "center" },
  emblemZone: { height: 300, alignItems: "center", justifyContent: "center" },
  orbit: { position: "absolute" },
  emblem: { width: 132, height: 132, borderRadius: 66 },
  tray: {
    marginHorizontal: -20,
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 16,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderColor: c.lineStrong,
  },
  handle: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, marginTop: 9, backgroundColor: c.handle },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 54,
    paddingLeft: 16,
    paddingRight: 5,
    borderRadius: xayraRadius.field,
    backgroundColor: c.field,
    borderWidth: 1,
    borderColor: c.lineStrong,
  },
  flex: { flex: 1 },
  answer: { gap: ANSWER_PARAGRAPH_GAP / 2, paddingHorizontal: 4 },
  gapTop: { marginTop: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  dock: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
    padding: 6,
    borderRadius: xayraRadius.dock,
    backgroundColor: c.dock,
    borderWidth: 1,
    borderColor: c.lineStrong,
  },
  scale: { gap: 10 },
  scaleRow: { gap: 2 },
});
