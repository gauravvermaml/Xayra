import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

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
    </>
  );
}
