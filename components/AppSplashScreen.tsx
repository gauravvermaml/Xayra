import { Image, StyleSheet, Text, View } from "react-native";

/**
 * Build 39: the native splash screen (app.json's `expo-splash-screen`
 * config) can only ever show a single static image — no text layer, no way
 * to add "Xayra" / "Your Pocket Companion" underneath the logo without a
 * new image asset AND a native rebuild to test it. This screen picks up
 * immediately where the native splash hands off (rendered by
 * app/_layout.tsx in place of the bare black `View` that used to sit there
 * while `isSetupComplete()` is still being read), using the exact same
 * `splash-icon.png` and background color as the native splash so the
 * hand-off reads as one continuous screen, not two. Pure JS/text — pushable
 * and editable via Metro like everything else, no native asset or rebuild
 * needed for future copy tweaks.
 */
export function AppSplashScreen() {
  return (
    <View style={styles.container}>
      {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
      <Image source={require("../assets/splash-icon.png")} style={styles.logo} resizeMode="contain" />
      <Text style={styles.title}>Xayra</Text>
      <Text style={styles.subtitle}>Your Pocket Companion</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // Matches app.json's expo-splash-screen `backgroundColor` exactly —
    // the whole point of this screen is a seamless continuation of the
    // native splash, not a visibly different second screen.
    backgroundColor: "#0E0F12",
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: 120,
    height: 120,
  },
  title: {
    marginTop: 16,
    color: "#F8FAFC",
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  subtitle: {
    marginTop: 4,
    color: "#94A3B8",
    fontSize: 14,
    fontWeight: "500",
  },
});
