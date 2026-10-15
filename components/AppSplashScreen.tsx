import { useCallback, useEffect, useRef } from "react";
import { Animated, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import * as SplashScreen from "expo-splash-screen";

import { colors } from "../constants/theme";
import type { VaultLockReason } from "../services/crypto/vaultLockState";

/**
 * Cold-start splash, the React half of one continuous screen.
 *
 * The native splash (`expo-splash-screen`, `app.json`) is held on screen by
 * app/_layout.tsx's module-level `preventAutoHideAsync()` and released here
 * only once this screen's logo has actually loaded, so the native icon is
 * replaced by a pixel-identical one underneath it rather than cross-fading
 * into a different layout. Measured on device (standalone Xayra Dev builds):
 * the native icon renders at exactly `imageWidth` dp, uncropped, centred on
 * the full screen (status and navigation bar areas included) — Android 11
 * (Redmi, androidx compat splash) and Android 14 (Pixel 6 emulator, platform
 * splash) alike. Android 12+ only masks to a 192dp circle inside the 288dp
 * icon canvas, which a 120dp icon never reaches.
 *
 * Invariants for the hand-off to stay seamless:
 *  - `SPLASH_LOGO_SIZE` equals `imageWidth` in app.json's expo-splash-screen block.
 *  - Both sides draw the same file, `assets/splash-icon-round.png` (the
 *    original emblem art, circular transparent framing only).
 *  - The logo is centred in a full-screen container and the wordmark is
 *    absolutely positioned below it, so the text never shifts the logo.
 *  - The app draws edge-to-edge (`edgeToEdgeEnabled`, every API level), so
 *    this container's centre is the full-screen centre the native icon uses
 *    — no inset arithmetic.
 *  - app.json's top-level `backgroundColor` (expo-system-ui ->
 *    `android:windowBackground`) is the splash colour, so a frame where
 *    neither splash is drawn shows the same colour, not the theme default.
 *
 * Released on the logo's `onLoad`, which means the image view is mounted
 * and decoded — on the Redmi it fires ~140ms after the activity is displayed,
 * even while the native splash is holding the draw. Releasing on `onLayout`
 * instead was measured to uncover the window background before the React
 * views had drawn. The wordmark fades in under the native splash's exit fade
 * (duration set in app/_layout.tsx).
 * `HIDE_FALLBACK_MS` only applies if the image never reports load or error;
 * app/_layout.tsx also releases the native splash once the setup gate
 * resolves, and expo-router hides it on any fatal JS error.
 */
export const SPLASH_LOGO_SIZE = 120;

export type SplashLock = {
  reason: VaultLockReason;
  /** An attempt is in flight — the button is disabled so taps can't stack prompts. */
  unlocking: boolean;
  onUnlock: () => void;
  /** Key-missing only (canRecoverOriginalVault): opens original-vault recovery. */
  onRecover?: () => void;
};

const LOCKED = {
  title: "Xayra is locked",
  detail: "Your notes stay encrypted until you unlock.",
  action: "Unlock Xayra",
};

const LOCK_COPY: Record<VaultLockReason, { title: string; detail: string; action: string }> = {
  userCancelled: LOCKED,
  systemCancelled: LOCKED,
  timeout: { ...LOCKED, title: "Unlock timed out" },
  lockout: {
    title: "Too many attempts",
    detail: "Fingerprint is paused for a moment. Wait about 30 seconds, then unlock.",
    action: "Unlock Xayra",
  },
  lockoutPermanent: {
    title: "Fingerprint is locked",
    detail: "Unlock your phone with your PIN, pattern or password, then unlock Xayra.",
    action: "Unlock Xayra",
  },
  keyUnavailable: {
    title: "Xayra couldn't unlock",
    detail: "Your phone's secure storage didn't respond. Nothing was changed.",
    action: "Try again",
  },
  keyMissing: {
    title: "Xayra can't unlock your notes",
    detail: "This phone no longer has the key to your encrypted notes, which can happen after fingerprints change. Nothing has been deleted.",
    action: "Try again",
  },
  databaseError: {
    title: "Xayra couldn't open your notes",
    detail: "Nothing was changed. Try again, or restart the app.",
    action: "Try again",
  },
  encryptionUnavailable: {
    title: "Xayra can't protect your notes",
    detail: "This version of Xayra is missing its encryption component, so it won't open your notes. Nothing was changed. Please update Xayra.",
    action: "Try again",
  },
  vaultConflict: {
    title: "Xayra needs attention",
    detail: "Your notes' files aren't in the state Xayra expects, so it stopped rather than guess. Nothing was changed or deleted.",
    action: "Try again",
  },
  insufficientStorage: {
    title: "Not enough space to secure your notes",
    detail: "Xayra needs free space to encrypt your notes safely. Free up some storage, then try again. Nothing was changed.",
    action: "Try again",
  },
  migrationFailed: {
    title: "Securing your notes didn't finish",
    detail: "Your original notes are untouched. Try again — Xayra will start the step over.",
    action: "Try again",
  },
};

const HIDE_FALLBACK_MS = 1000;
const WORDMARK_FADE_MS = 280;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

let nativeSplashReleased = false;

/** Idempotent — safe to call from every path that may be first to finish. */
export function releaseNativeSplash(): void {
  if (nativeSplashReleased) {
    return;
  }
  nativeSplashReleased = true;
  try {
    SplashScreen.hide();
  } catch (err) {
    console.warn("[Splash] Failed to hide the native splash:", err);
  }
}

export function AppSplashScreen({ lock = null }: { lock?: SplashLock | null }) {
  const { width: screenWidth } = useWindowDimensions();
  const titleFontSize = clamp(screenWidth * 0.075, 26, 34);
  const subtitleFontSize = clamp(screenWidth * 0.028, 10, 13);

  const wordmarkOpacity = useRef(new Animated.Value(0)).current;
  const revealed = useRef(false);

  const reveal = useCallback(() => {
    if (revealed.current) {
      return;
    }
    revealed.current = true;
    releaseNativeSplash();
    Animated.timing(wordmarkOpacity, {
      toValue: 1,
      duration: WORDMARK_FADE_MS,
      useNativeDriver: true,
    }).start();
  }, [wordmarkOpacity]);

  useEffect(() => {
    const fallback = setTimeout(reveal, HIDE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [reveal]);

  return (
    <View style={styles.container}>
      <Image
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        source={require("../assets/splash-icon-round.png")}
        style={styles.logo}
        fadeDuration={0}
        onLoad={reveal}
        onError={reveal}
        accessibilityIgnoresInvertColors
      />
      <Animated.View style={[styles.wordmark, { opacity: wordmarkOpacity }]} pointerEvents="box-none">
        <Text style={[styles.title, { fontSize: titleFontSize }]}>Xayra</Text>
        <Text style={[styles.subtitle, { fontSize: subtitleFontSize }]}>Your Pocket Companion</Text>
        {lock ? <LockPanel lock={lock} /> : null}
      </Animated.View>
    </View>
  );
}

/** Flows in the wordmark's column, below it, so it follows the text at any
 * font scale — the logo, centred independently, never moves. */
function LockPanel({ lock }: { lock: SplashLock }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: WORDMARK_FADE_MS, useNativeDriver: true }).start();
  }, [opacity]);

  const copy = LOCK_COPY[lock.reason];
  return (
    <Animated.View style={[styles.lockPanel, { opacity }]}>
      <Text style={styles.lockTitle} accessibilityRole="header">
        {copy.title}
      </Text>
      <Text style={styles.lockDetail}>{copy.detail}</Text>
      <Pressable
        onPress={lock.onUnlock}
        disabled={lock.unlocking}
        accessibilityRole="button"
        accessibilityState={{ disabled: lock.unlocking, busy: lock.unlocking }}
        style={({ pressed }) => [
          styles.unlockButton,
          (pressed || lock.unlocking) && styles.unlockButtonPressed,
        ]}
      >
        <Text style={styles.unlockLabel}>{lock.unlocking ? "Unlocking…" : copy.action}</Text>
      </Pressable>
      {lock.reason === "keyMissing" && lock.onRecover ? (
        <Pressable
          onPress={lock.onRecover}
          disabled={lock.unlocking}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => [styles.recoverLink, pressed && styles.unlockButtonPressed]}
        >
          <Text style={styles.recoverLabel}>Recover my notes</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    // Matches app.json's expo-splash-screen `backgroundColor`.
    backgroundColor: "#0E0F12",
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: SPLASH_LOGO_SIZE,
    height: SPLASH_LOGO_SIZE,
  },
  wordmark: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    marginTop: SPLASH_LOGO_SIZE / 2 + 24,
    alignItems: "center",
  },
  title: {
    color: "#F8FAFC",
    fontWeight: "700",
    letterSpacing: -0.8,
  },
  subtitle: {
    marginTop: 8,
    color: "#94A3B8",
    fontWeight: "500",
  },
  lockPanel: {
    marginTop: 40,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  lockTitle: {
    color: "#F8FAFC",
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  lockDetail: {
    marginTop: 6,
    maxWidth: 320,
    color: "#94A3B8",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  unlockButton: {
    marginTop: 20,
    minHeight: 48,
    minWidth: 200,
    paddingHorizontal: 28,
    borderRadius: 24,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  unlockButtonPressed: {
    opacity: 0.7,
  },
  recoverLink: {
    marginTop: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  recoverLabel: {
    color: "#94A3B8",
    fontSize: 14,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  unlockLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
});
