import { AppState } from "react-native";

import type { ManualUtterancePhase, UtteranceMode } from "../audio/manualUtterance";

/**
 * Android launcher shortcuts ("Record with Xayra", "Ask Xayra" — declared
 * by plugins/withAppShortcuts.js) open the app with
 * `<scheme>://shortcut?mode=record|ask`. app/+native-intent.tsx turns that
 * link into a pending shortcut here (and routes to Home); Home takes it
 * once and starts the SAME manual recording a central-button tap does, in
 * the shortcut's mode.
 *
 * Consume-once by construction: `takePendingShortcut` clears it, so
 * re-renders, focus changes, Strict Mode double effects and app resumes
 * can't start a second recording.
 *
 * LAUNCH TRANSACTION (replaces a fixed 20 s expiry): a shortcut belongs to
 * the launch that delivered it, and stays valid while that launch is
 * progressing — foreground → biometric unlock / setup check → Home ready —
 * however long the fingerprint takes. It ends when:
 *   - it's consumed (once);
 *   - a newer shortcut replaces it;
 *   - setup is incomplete (useDiscardShortcutsDuringSetup);
 *   - the app goes to the background after this launch reached the
 *     foreground — the user left, the screen locked, or Home was pressed
 *     mid-unlock (noteAppStateForShortcut).
 * The fingerprint prompt does NOT end it: confirmed in the event log that
 * the BiometricPrompt window takes focus without pausing the activity, so
 * AppState stays "active". Nothing survives the process (in-memory only),
 * and a Recents relaunch's replayed intent is dropped natively.
 */

export type PendingShortcut = {
  mode: UtteranceMode;
  receivedAt: number;
  /** Increments per delivered shortcut — identifies the launch. */
  launch: number;
  /** Set once this launch has had the app in the foreground; a background
   * transition after that abandons it. */
  foregrounded: boolean;
};

let launchCounter = 0;

let pending: PendingShortcut | null = null;
const listeners = new Set<() => void>();

/** `xayra://shortcut?mode=record` (any scheme — production and Xayra Dev
 * differ) → "record"; anything else → null, so ordinary links pass by. */
export function parseShortcutUrl(url: string | null | undefined): UtteranceMode | null {
  if (!url) return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/shortcut\/?\?(.*)$/i.exec(url.trim());
  if (!match) return null;
  const mode = new URLSearchParams(match[1]).get("mode");
  return mode === "record" || mode === "ask" ? mode : null;
}

export function setPendingShortcut(mode: UtteranceMode, now: number = Date.now()): void {
  // A warm launch's link lands while the app is still in the background;
  // a cold launch's while it's already active.
  pending = { mode, receivedAt: now, launch: ++launchCounter, foregrounded: AppState.currentState === "active" };
  listeners.forEach((listener) => listener());
}

/** The pending shortcut, left in place — lets Home render the requested
 * mode from its very first frame (cold start) or as soon as a warm launch
 * arrives, before it is taken and acted on. */
export function peekPendingShortcut(): PendingShortcut | null {
  return pending;
}

/** Removes and returns the pending shortcut (null if none). */
export function takePendingShortcut(): PendingShortcut | null {
  const taken = pending;
  pending = null;
  return taken;
}

/** Forget any pending shortcut — e.g. when setup isn't complete, so it
 * can't start recording much later, out of context. */
export function discardPendingShortcut(): void {
  pending = null;
}

export function hasPendingShortcut(): boolean {
  return pending !== null;
}

/**
 * Feeds app foreground/background changes into the launch transaction
 * (called from the root layout for the app's whole lifetime).
 */
export function noteAppStateForShortcut(next: string): void {
  if (!pending) return;
  if (next === "active") {
    pending.foregrounded = true; // mutated, not replaced: same launch
  } else if (next === "background" && pending.foregrounded) {
    pending = null;
  }
}

/** Notified whenever a shortcut arrives (warm launches). */
export function subscribeToShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type ShortcutLaunchAction =
  /** Select the mode and start recording, exactly like a central tap. */
  | "start"
  /** Select the mode only; the user taps to begin (the microphone
   * permission still needs the normal tap-triggered prompt). */
  | "select-only"
  /** Something is already recording/processing, or another part of the
   * app owns the microphone — leave it alone. */
  | "busy"
  /** Handsfree owns the microphone — leave it (and the mode) alone. */
  | "handsfree";

/**
 * What a shortcut launch does, given the app's state when Home takes it.
 * Never starts a competing mic session and never bypasses the permission
 * flow.
 */
export function decideShortcutLaunch(state: {
  manualPhase: ManualUtterancePhase;
  isProcessing: boolean;
  isRecorderBusy: boolean;
  isHandsfreeActive: boolean;
  /** App-wide: any capture session open (audioInputState.isMicInUse) — not
   * just this screen's, so no second native mic owner is ever created. */
  isMicInUse: boolean;
  micPermissionGranted: boolean;
}): ShortcutLaunchAction {
  if (state.manualPhase !== "idle" || state.isProcessing || state.isRecorderBusy) return "busy";
  if (state.isHandsfreeActive) return "handsfree";
  if (state.isMicInUse) return "busy";
  if (!state.micPermissionGranted) return "select-only";
  return "start";
}

/**
 * Whether Home may switch its Record/Ask selection to a just-arrived
 * shortcut's mode before acting on it: never under an active utterance,
 * processing, or Handsfree (those keep their mode).
 */
export function canAdoptShortcutMode(state: {
  manualPhase: ManualUtterancePhase;
  isProcessing: boolean;
  isRecorderBusy: boolean;
  isHandsfreeActive: boolean;
  isMicInUse: boolean;
}): boolean {
  return (
    state.manualPhase === "idle" &&
    !state.isProcessing &&
    !state.isRecorderBusy &&
    !state.isHandsfreeActive &&
    !state.isMicInUse
  );
}
