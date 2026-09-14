import { Image, StyleSheet, Text, View } from "react-native";

/**
 * Build 39/40: the native splash (`expo-splash-screen`, `app.json`) can only
 * ever show a small icon — confirmed by reading its actual Android
 * implementation (`SplashScreenManager.kt`): it calls Android 12+'s own
 * `installSplashScreen()` platform API, which forcibly constrains and
 * centers whatever icon it's given inside a fixed ~240dp window (the same
 * safe-zone adaptive app icons use), regardless of the source image's real
 * dimensions. There is no way to make that particular screen show a large
 * logo + wordmark — it's a hard platform limit, not a sizing choice. (This
 * is also almost certainly why LinkedIn/Amazon-style "big logo splash"
 * screens are never actually the OS-native splash on modern Android — they
 * show their own small icon there too, then hand off to a screen like this
 * one.)
 *
 * This screen picks up immediately where that constrained native icon hands
 * off (rendered by app/_layout.tsx in place of the bare colored `View` that
 * used to sit there while `isSetupComplete()` is still being read), using
 * the exact same background color as the native splash so the hand-off
 * reads as one continuous reveal — small icon fading into full branding —
 * rather than two unrelated screens. (A first attempt at this same idea
 * used the native splash's own small icon size throughout and was reverted
 * after on-device testing; this version is deliberately sized large now
 * that it's not fighting the OS's icon-frame constraint.) Pure JS/text —
 * pushable and editable via Metro like everything else, no native asset or
 * rebuild needed for future copy tweaks.
 */
export function AppSplashScreen() {
  return (
    <View style={styles.container}>
      {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
      <Image source={require("../assets/icon.png")} style={styles.logo} resizeMode="contain" />
      <Text style={styles.title}>Xayra</Text>
      <Text style={styles.subtitle}>Your Pocket Companion</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // Matches app.json's expo-splash-screen `backgroundColor` and the
    // native splash icon's own background exactly — the whole point of
    // this screen is a seamless continuation of the native splash, not a
    // visibly different second screen.
    backgroundColor: "#0E0F12",
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: 200,
    height: 193, // matches icon.png's 302:291 aspect ratio
  },
  title: {
    marginTop: 24,
    color: "#F8FAFC",
    fontSize: 44,
    fontWeight: "700",
    letterSpacing: -0.8,
  },
  subtitle: {
    marginTop: 8,
    color: "#94A3B8",
    fontSize: 19,
    fontWeight: "500",
  },
});
