import { Image, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { colors } from "../constants/theme";

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
 * rather than two unrelated screens. Pure JS/text — pushable and editable
 * via Metro like everything else, no native asset or rebuild needed for
 * future copy tweaks.
 *
 * Build 48, live user request: sizing here used to be flat hardcoded dp/sp
 * values — same absolute size on a small phone and a tablet. Now derived
 * from `useWindowDimensions()` (live, reacts to actual window size, not a
 * one-time `Dimensions.get()` snapshot) as a percentage of screen width,
 * each clamped to a sane min/max so a very narrow phone doesn't shrink the
 * wordmark into illegibility and a tablet doesn't blow the logo up huge.
 * "Compact" preset, chosen from three options presented to the user: logo
 * width 24% of screen width (100–150dp), title 7.5% (26–34sp), subtitle
 * 2.8% (10–13sp). On a ~390dp phone (Redmi Note 8 Pro / Pixel 9 range) that
 * comes out to roughly a 100dp logo, 29sp title, 11sp subtitle.
 *
 * Round frame, live user request: matches CentralRecorderCanvas's own
 * `button`/`buttonLogo` treatment for the record button — a square,
 * `overflow: "hidden"` frame with `borderRadius` = half its side, an
 * accent-colored fill behind the image as a fallback, and `resizeMode:
 * "cover"` so the source image fills the circle edge-to-edge with no
 * letterboxing rather than `contain`'s uncropped rectangle floating inside
 * a circular frame.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function AppSplashScreen() {
  const { width: screenWidth } = useWindowDimensions();

  const logoSize = clamp(screenWidth * 0.24, 100, 150);
  const titleFontSize = clamp(screenWidth * 0.075, 26, 34);
  const subtitleFontSize = clamp(screenWidth * 0.028, 10, 13);

  return (
    <View style={styles.container}>
      <View style={[styles.logoFrame, { width: logoSize, height: logoSize, borderRadius: logoSize / 2 }]}>
        {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
        <Image source={require("../assets/icon.png")} style={styles.logoImage} resizeMode="cover" />
      </View>
      <Text style={[styles.title, { fontSize: titleFontSize }]}>Xayra</Text>
      <Text style={[styles.subtitle, { fontSize: subtitleFontSize }]}>Your Pocket Companion</Text>
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
  logoFrame: {
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    // Required to actually clip the image below into a circle — RN doesn't
    // apply a parent's borderRadius as a clip mask to children by default.
    overflow: "hidden",
  },
  logoImage: {
    width: "100%",
    height: "100%",
  },
  title: {
    marginTop: 24,
    color: "#F8FAFC",
    fontWeight: "700",
    letterSpacing: -0.8,
  },
  subtitle: {
    marginTop: 8,
    color: "#94A3B8",
    fontWeight: "500",
  },
});
