import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { ToastHost } from "../components/Toast";

const colors = {
  background: "#0B0B0F",
};

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
      {/* Mounted once at the root so every screen's copy-to-clipboard
          feedback (see utils/clipboard.ts) renders on the same overlay,
          above whichever screen or modal is currently on top. */}
      <ToastHost />
    </>
  );
}
