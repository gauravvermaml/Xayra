import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as SplashScreen from "expo-splash-screen";

import { AppSplashScreen, releaseNativeSplash } from "../components/AppSplashScreen";
import { DisposableVaultBanner } from "../components/DisposableVaultBanner";
import { RecoverNotesFlow } from "../components/RecoverNotesFlow";
import { resolveVaultMode, type VaultMode } from "../services/dev/disposableVault";
import { clearRecoveryRecord, readRecoveryPhase } from "../services/recovery/originalVaultRecovery";
import { cancelStaleDisposableReminders, reconcileToDoNotifications } from "../services/notifications/todoNotifications";
import { listAllToDos } from "../services/todos/todoManager";
import { OnboardingSetupScreen } from "../components/OnboardingSetupScreen";
import { showToast, ToastHost } from "../components/Toast";
import { releaseLocalLlamaOnBackground } from "../services/ai/localLlama";
import { releaseWhisperContext } from "../services/ai/localWhisper";
import { initModelDownloads } from "../services/ai/modelDownloadManager";
import { allowDownloadNotificationPermissionPrompt } from "../services/notifications/downloadNotification";
import {
  canRecoverOriginalVault,
  isExpectedLockReason,
  singleFlight,
  vaultLockReasonFor,
  type VaultLockReason,
} from "../services/crypto/vaultLockState";
import { isSetupComplete } from "../services/settings/appSettings";
import { useDiscardShortcutsDuringSetup, useShortcutLaunchTransaction } from "../hooks/useLaunchShortcut";

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

// Keep the native splash up until AppSplashScreen has drawn its identical
// logo underneath (see that file). Must run at module load, before React's
// first frame, or the native splash auto-hides on content-appeared.
// Exit fade of the native splash. React's first real draw only starts once
// the splash is released, and on a slow device it lands ~150ms later; the
// default 400ms accelerate fade had already uncovered an empty frame by then
// (measured on the Redmi). 600ms keeps the native logo near full opacity
// until the identical React logo is drawn underneath. This is only the
// overlay's animation — startup and JS are not held back by it.
SplashScreen.setOptions({ duration: 600 });
SplashScreen.preventAutoHideAsync().catch((err: unknown) => {
  console.warn("[Splash] preventAutoHideAsync failed:", err);
});

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
 * Locked: reading the flag opens the encrypted database, which needs the
 * biometric-gated key. Every way that attempt can end without opening the
 * vault maps to an explicit state (services/crypto/vaultLockState.ts) — an
 * authentication outcome shows Unlock, a key or database failure shows Try
 * again. Either way nothing is opened, created or reset, and nothing
 * re-prompts on its own (not even on returning to the foreground — a prompt
 * the user just dismissed must not reappear unasked).
 *
 * Splash: the native splash can only show an icon (Android 12+ masks it to a
 * 192dp circle inside a 288dp canvas), so the wordmark lives in
 * `AppSplashScreen`, which draws the same icon at the same size and centre
 * and releases the native splash once it has. RootLayout also releases it as
 * soon as the gate resolves, so onboarding or the app can never be left
 * hidden behind it.
 */
type SetupGate = {
  /** `null` until the vault has been opened and the flag read. */
  setupComplete: boolean | null;
  /** Why the vault is still closed, once an attempt has ended without opening it. */
  lockReason: VaultLockReason | null;
  /** An unlock attempt (and so possibly a biometric prompt) is in flight. */
  unlocking: boolean;
  unlock: () => void;
  markComplete: () => void;
};

function useSetupGate(): SetupGate {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [lockReason, setLockReason] = useState<VaultLockReason | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  // Single flight: one attempt — and so at most one biometric prompt — at a
  // time, however fast Unlock is tapped (vaultLockState.ts `singleFlight`).
  // Opening the encrypted database is what asks for the key, and so what
  // shows the prompt (services/crypto/keyManager.ts). A failed open is never
  // cached (db/client.ts), so each attempt is a fresh prompt.
  const runAttempt = useRef(singleFlight(isSetupComplete)).current;
  const mounted = useRef(true);

  const unlock = useCallback(() => {
    const attempt = runAttempt();
    if (!attempt) {
      return;
    }
    setUnlocking(true);
    void attempt
      .then((complete) => {
        if (mounted.current) {
          setLockReason(null);
          setSetupComplete(complete);
        }
      })
      .catch((err: unknown) => {
        const reason = vaultLockReasonFor(err);
        if (isExpectedLockReason(reason)) {
          // Cancel/timeout/lockout: not a fault. The vault stays closed until
          // the user asks to try again; only the reason is logged.
          console.warn(`[Setup] Vault still locked (${reason}).`);
        } else {
          console.error(`[Setup] Vault could not be opened (${reason}):`, err);
        }
        if (mounted.current) {
          setLockReason(reason);
        }
      })
      .finally(() => {
        if (mounted.current) {
          setUnlocking(false);
        }
      });
  }, [runAttempt]);

  useEffect(() => {
    mounted.current = true;
    unlock();
    return () => {
      mounted.current = false;
    };
  }, [unlock]);

  const markComplete = useCallback(() => setSetupComplete(true), []);

  return { setupComplete, lockReason, unlocking, unlock, markComplete };
}

/**
 * Build 41 P0 fix (qa/05-consolidated-triage.md P0-4): neither llama.rn's
 * nor whisper.rn's native context was ever released when the app
 * backgrounds — confirmed nothing anywhere called `releaseLocalLlama()`/an
 * equivalent Whisper release in response to app lifecycle at all (a
 * repo-wide `AppState` grep before this fix returned nothing real). A
 * loaded model's native C++-heap footprint (up to ~3.6GB RSS for a 3B Llama
 * context, per localLlama.ts's own doc comment) stayed fully resident for
 * the app's entire backgrounded lifetime — a plausible contributing factor
 * to the LMKD kill this app has already been hit by once (see
 * services/ai/memoryGuard.ts's Build 40 doc comment). This is the one file
 * mounted for the app process's entire lifetime regardless of which screen
 * is showing (onboarding or the real Stack render underneath this same root
 * component), so this is the single right place for this listener rather
 * than duplicating it per-screen.
 */
function useReleaseNativeContextsOnBackground(): void {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState !== "background") {
        return;
      }
      void releaseLocalLlamaOnBackground().catch((err) => {
        console.warn("[RootLayout] Failed to release Llama context on background:", err);
      });
      void releaseWhisperContext().catch((err) => {
        console.warn("[RootLayout] Failed to release Whisper context on background:", err);
      });
    });
    return () => subscription.remove();
  }, []);
}

/** This process's vault mode (services/dev/disposableVault.ts) — `"normal"`
 * until resolved, which is immediate outside Xayra Dev. */
function useVaultMode(): VaultMode {
  const [mode, setMode] = useState<VaultMode>("normal");
  useEffect(() => {
    let cancelled = false;
    void resolveVaultMode().then((resolved) => {
      if (!cancelled) setMode(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return mode;
}

export default function RootLayout() {
  const { setupComplete, lockReason, unlocking, unlock, markComplete: markSetupGateComplete } = useSetupGate();
  useReleaseNativeContextsOnBackground();
  useDiscardShortcutsDuringSetup(setupComplete);
  useShortcutLaunchTransaction();

  useEffect(() => {
    if (setupComplete !== null || lockReason !== null) {
      releaseNativeSplash();
    }
  }, [setupComplete, lockReason]);

  // Original-vault recovery (key-missing only, every build). It ends by
  // handing back to the normal unlock — the only thing that proves recovery.
  const [recovering, setRecovering] = useState(false);
  const recoveryAvailable = canRecoverOriginalVault(lockReason);
  useEffect(() => {
    if (!recoveryAvailable) setRecovering(false);
  }, [recoveryAvailable]);
  const recoveryKeyInstalled = useRef(false);
  useEffect(() => {
    if (setupComplete === null) return;
    // Opened through normal authentication: only now is recovery done.
    void readRecoveryPhase()
      .then((phase) => {
        if (phase === null) return;
        void clearRecoveryRecord().catch(() => {});
        if (phase === "keyInstalled" || recoveryKeyInstalled.current) {
          showToast("Your notes are unlocked.");
        }
      })
      .catch(() => {});
  }, [setupComplete]);

  const vaultMode = useVaultMode();
  // Once the vault is open (either mode, before any to-do exists in it):
  // clear reminders a previous disposable test-vault session left behind.
  // Touches only the disposable namespace, never normal reminders.
  const vaultOpen = setupComplete !== null;
  useEffect(() => {
    if (vaultOpen) {
      // Then re-arm pending future reminders from the encrypted to-dos: a
      // force-stop removes an app's alarms, and reopening never restored
      // them (Gate 2). Once per process, idempotent, never prompts.
      void cancelStaleDisposableReminders()
        .then(() => listAllToDos())
        .then((todos) => reconcileToDoNotifications(todos))
        .catch(() => {});
      // Only now may the download notification ask for permission: earlier,
      // its dialog would cancel the vault's fingerprint prompt.
      allowDownloadNotificationPermissionPrompt();
    }
  }, [vaultOpen]);

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
      ) : recovering && recoveryAvailable ? (
        <RecoverNotesFlow
          onClose={() => setRecovering(false)}
          onKeyInstalled={() => {
            recoveryKeyInstalled.current = true;
            setRecovering(false);
            unlock();
          }}
        />
      ) : (
        <AppSplashScreen
          lock={
            lockReason === null
              ? null
              : {
                  reason: lockReason,
                  unlocking,
                  onUnlock: unlock,
                  onRecover: recoveryAvailable ? () => setRecovering(true) : undefined,
                }
          }
        />
      )}
      {/* Mounted once at the root so every screen's copy-to-clipboard
          feedback (see utils/clipboard.ts) renders on the same overlay,
          above whichever screen or modal is currently on top. */}
      <ToastHost />
      {vaultMode === "disposable" ? <DisposableVaultBanner /> : null}
    </GestureHandlerRootView>
  );
}
