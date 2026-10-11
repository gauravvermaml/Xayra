import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import {
  discardPendingShortcut,
  hasPendingShortcut,
  noteAppStateForShortcut,
  peekPendingShortcut,
  subscribeToShortcuts,
  takePendingShortcut,
  type PendingShortcut,
} from "../services/shortcuts/launchShortcut";

/**
 * Hands a pending launcher shortcut (services/shortcuts/launchShortcut.ts)
 * to `onShortcut` exactly once, at the first moment it's safe to act on:
 * the screen is ready and focused (`enabled`) AND the app is in the
 * foreground — Android won't deliver real microphone audio to a
 * backgrounded app, and a warm-launch link can arrive a beat before the
 * app reports itself active.
 *
 * Checked on: enabling (cold start / returning to Home), a shortcut
 * arriving (warm launch while on Home), and the app becoming active.
 * The shortcut is taken (cleared) before `onShortcut` runs, so any number
 * of these firing together still acts once.
 *
 * `onArrive` sees each new pending shortcut as soon as it's known (without
 * taking it) — a warm launch's link lands before the app is visible, so
 * Home can show the requested mode on its first visible frame instead of
 * flipping to it afterwards.
 */
export function useLaunchShortcut({
  enabled,
  onShortcut,
  onArrive,
}: {
  enabled: boolean;
  onShortcut: (shortcut: PendingShortcut) => void;
  onArrive?: (shortcut: PendingShortcut) => void;
}): void {
  const onShortcutRef = useRef(onShortcut);
  onShortcutRef.current = onShortcut;
  const onArriveRef = useRef(onArrive);
  onArriveRef.current = onArrive;
  const announcedRef = useRef<PendingShortcut | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const check = () => {
      const peeked = peekPendingShortcut();
      if (peeked && peeked !== announcedRef.current) {
        announcedRef.current = peeked;
        onArriveRef.current?.(peeked);
      }
      if (!enabledRef.current || AppState.currentState !== "active" || !hasPendingShortcut()) return;
      const shortcut = takePendingShortcut();
      if (shortcut) onShortcutRef.current(shortcut);
    };
    check();
    const unsubscribe = subscribeToShortcuts(check);
    const appState = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") check();
    });
    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [enabled]);
}

/**
 * A launcher shortcut must never bypass setup: while onboarding is showing
 * (`setupComplete === false`), any shortcut — already pending or arriving
 * later — is dropped, so it can't start a recording minutes later when Home
 * first appears. `null` (still checking) keeps it for Home.
 */
export function useDiscardShortcutsDuringSetup(setupComplete: boolean | null): void {
  useEffect(() => {
    if (setupComplete !== false) return;
    discardPendingShortcut();
    return subscribeToShortcuts(discardPendingShortcut);
  }, [setupComplete]);
}

/**
 * Mounted once at the root for the app's lifetime: ends a pending
 * shortcut's launch transaction if the app goes to the background before
 * Home uses it (see launchShortcut.ts's LAUNCH TRANSACTION note).
 */
export function useShortcutLaunchTransaction(): void {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", noteAppStateForShortcut);
    return () => subscription.remove();
  }, []);
}
