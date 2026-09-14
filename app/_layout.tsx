import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AppSplashScreen } from "../components/AppSplashScreen";
import { OnboardingSetupScreen } from "../components/OnboardingSetupScreen";
import { ToastHost } from "../components/Toast";
import { initModelDownloads } from "../services/ai/modelDownloadManager";
import { isSetupComplete } from "../services/settings/appSettings";

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

/**
 * "One Door, Opens Once" root guard. `null` while the flag is still being
 * read from SQLite (a handful of milliseconds — rendered as `AppSplashScreen`,
 * matching the native splash's own background color for a seamless hand-off),
 * then either `false` (render OnboardingSetupScreen, full-screen, in place of
 * the real app) or `true` (render the normal Stack) for the rest of this app
 * process's life — re-checked fresh on every cold start, but never again
 * once true, so a later launch can't accidentally re-trigger onboarding for
 * a device that's already set up.
 *
 * Build 39/40 splash history, worth keeping straight: the native splash
 * (`expo-splash-screen`) can only ever show a small icon — confirmed by
 * reading its actual Android implementation, it calls Android 12+'s own
 * `installSplashScreen()` platform API, which forcibly constrains any icon
 * to a fixed ~240dp window regardless of the source image's real size. A
 * first attempt baked "Xayra"/"Your Pocket Companion" text directly into
 * the splash image itself to get a single native screen — that text was
 * silently squeezed into the same tiny icon frame and never actually
 * legible. `AppSplashScreen` (this file) is the real fix: it can't make the
 * OS's own icon bigger, but it can show full-size branding the instant that
 * constrained icon hands off, with an identical background color so the two
 * read as one continuous reveal rather than a visible seam.
 */
function useSetupGate(): [boolean | null, () => void] {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Diagnostic addition: `isSetupComplete()` previously had no `.catch()`
    // here at all — a genuine failure (rather than just "still loading")
    // would leave `ready` stuck at `null` forever, rendering nothing, with
    // no error surfaced anywhere to explain why. Confirmed the hard way:
    // on a device whose screen is locked, first-ever encryption-key
    // creation (services/crypto/keyManager.ts, biometric-gated) can never
    // complete — a completely different, pre-existing constraint, unrelated
    // to this gate itself, but this gate had no way to ever report it.
    void isSetupComplete()
      .then((complete) => {
        if (!cancelled) {
          setReady(complete);
        }
      })
      .catch((err) => {
        console.error("[Setup] isSetupComplete() failed — staying on the splash screen:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return [ready, () => setReady(true)];
}

export default function RootLayout() {
  const [setupComplete, markSetupGateComplete] = useSetupGate();

  return (
    // Required once anywhere above any react-native-gesture-handler consumer
    // (the bottom sheet's drag handle, in this app) — without it, pan/swipe
    // gestures on Android silently fail to register at all.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      {setupComplete === false ? (
        <OnboardingSetupScreen onComplete={markSetupGateComplete} />
      ) : setupComplete === true ? (
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
      ) : (
        <AppSplashScreen />
      )}
      {/* Mounted once at the root so every screen's copy-to-clipboard
          feedback (see utils/clipboard.ts) renders on the same overlay,
          above whichever screen or modal is currently on top. */}
      <ToastHost />
    </GestureHandlerRootView>
  );
}
