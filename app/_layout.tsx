import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { ToastHost } from "../components/Toast";
import { initModelDownloads } from "../services/ai/modelDownloadManager";

const colors = {
  // True jet black — the unified Apple-Maps-style canvas (see app/index.tsx)
  // is deliberately #000000, not the app's usual slate background, so this
  // root fill has to match or a screen transition/notch area would flash
  // the old slate tone underneath it.
  background: "#000000",
};

// Fired once, at module load, rather than inside a component effect — this
// module is only ever imported once (the root layout), and starting the
// check immediately means a Wi-Fi-connected first launch can already be
// downloading before the user's even past the splash screen, instead of
// waiting for RootLayout's first render pass.
initModelDownloads();

export default function RootLayout() {
  return (
    // Required once anywhere above any react-native-gesture-handler consumer
    // (the bottom sheet's drag handle, in this app) — without it, pan/swipe
    // gestures on Android silently fail to register at all.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {/* Reached via the search header's settings gear (see
            components/HistorySheet.tsx) rather than a full-screen push, so
            it reads as a dismissible overlay over the jet-black canvas
            underneath instead of navigating away from it. */}
        <Stack.Screen name="settings" options={{ presentation: "modal" }} />
      </Stack>
      {/* Mounted once at the root so every screen's copy-to-clipboard
          feedback (see utils/clipboard.ts) renders on the same overlay,
          above whichever screen or modal is currently on top. */}
      <ToastHost />
    </GestureHandlerRootView>
  );
}
