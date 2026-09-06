import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

import type { ModelDownloadStatus } from "../ai/modelDownloadManager";

/**
 * Build 25 SYSTEM NOTIFICATION: mirrors the in-app download progress card
 * (components/ModelDownloadCard.tsx) into a persistent Android notification-
 * shade entry, so setup progress is visible even while Xayra isn't the
 * foreground app. This is a pure side effect, deliberately isolated in its
 * own file (one responsibility per file, per CLAUDE.md) and called from
 * services/ai/modelDownloadManager.ts's `setStatus` — it never reads or
 * decides download state itself, only reflects whatever it's handed.
 *
 * A missing/denied notification permission is treated as a soft failure
 * everywhere here: this is a nice-to-have status mirror, never a dependency
 * of the actual download (Zero-cloud-API core loop rule in CLAUDE.md) —
 * `void` every native call and swallow rejections rather than letting a
 * permission problem surface as an app-facing error.
 */

const CHANNEL_ID = "model-download";
const NOTIFICATION_ID = "xayra-model-download";

/** Update-shown-notification only when the rounded percent actually moves —
 * `setStatus` fires on every ~250ms progress tick (see modelDownloadManager's
 * MIN_SAMPLE_INTERVAL_MS), and re-issuing an identical native notification
 * that often would be pure overhead for no visible change. */
let lastShownPercent = -1;
let channelReady = false;
let permissionRequested = false;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Build 26 SILENT DOWNLOAD NOTIFICATION: no heads-up popover, no vibration,
 * ever — a background model download is not an event worth interrupting the
 * user for, only a status they can glance at in the shade if they choose to
 * pull it down. `AndroidImportance.LOW` alone already suppresses heads-up
 * banners, but LOW-importance channels default to whatever sound/vibration
 * the user's own device profile has set — `sound: null` and
 * `vibrationPattern: []`/`enableVibrate: false` close that gap explicitly
 * rather than relying on the importance level alone.
 */
async function ensureChannel(): Promise<void> {
  if (channelReady || Platform.OS !== "android") {
    return;
  }
  channelReady = true;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Model setup",
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
    vibrationPattern: [],
    enableVibrate: false,
    showBadge: false,
  }).catch(() => {
    channelReady = false;
  });
}

async function ensurePermission(): Promise<boolean> {
  if (permissionRequested) {
    const existing = await Notifications.getPermissionsAsync().catch(() => null);
    return existing?.granted ?? false;
  }
  permissionRequested = true;
  const existing = await Notifications.getPermissionsAsync().catch(() => null);
  if (existing?.granted) {
    return true;
  }
  const requested = await Notifications.requestPermissionsAsync().catch(() => null);
  return requested?.granted ?? false;
}

/**
 * Real bug, found on-device: the notification shade got stuck showing a
 * stale "82% of 100%" long after the in-app card had already disappeared
 * (download finished, status "ready"). Root cause — `ensurePermission()`
 * makes a real native async call (`getPermissionsAsync`/
 * `requestPermissionsAsync`) on every single invocation, and this used to
 * be kicked off independently, unawaited, on every ~250ms progress tick
 * (see modelDownloadManager's MIN_SAMPLE_INTERVAL_MS). Native calls that
 * start close together have NO guarantee of finishing in the order they
 * started: an earlier call queued while showing 82% could still be
 * in-flight when the download completed and `dismiss()` ran, then finish
 * LATER and silently re-create the notification with 82% again, after the
 * dismiss.
 *
 * Fixed with a monotonically increasing `latestSeq` — every call captures
 * its own sequence number, and checks it's still the newest one BOTH before
 * starting any native call and again after every `await`. A call that's
 * been superseded by a newer one (arrived while it was still queued behind
 * a permission check, or a channel setup) aborts without touching the
 * notification at all, so only the truly-latest status can ever actually
 * reach the native APIs — no out-of-order overwrite is possible.
 */
let latestSeq = 0;

async function applyStatus(status: ModelDownloadStatus, seq: number): Promise<void> {
  if (status.status === "downloading") {
    const percent = Math.round(status.progressPercent);
    if (percent === lastShownPercent) {
      return;
    }
    await ensureChannel();
    if (seq !== latestSeq) {
      return;
    }
    const granted = await ensurePermission();
    if (seq !== latestSeq || !granted) {
      return;
    }
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: {
        title: "Setting up Xayra",
        body: `Downloading in progress... ${percent}% of 100%`,
        // `sticky: true` is expo-notifications' equivalent of Android's
        // "ongoing" flag (non-dismissable by a swipe) — every progress
        // update re-issues it, so it stays ongoing for the life of the
        // download. `sound: false`/`vibrate: []`/`priority: LOW` repeat the
        // channel's own silence at the per-notification level too, since a
        // channel's settings can be overridden per-post on some OEM skins.
        sticky: true,
        autoDismiss: false,
        sound: false,
        vibrate: [],
        priority: Notifications.AndroidNotificationPriority.LOW,
        ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
      },
      trigger: null,
    });
    if (seq === latestSeq) {
      lastShownPercent = percent;
    }
    return;
  }
  // Every other state (ready, error, idle, cellular_blocked, paused_offline)
  // clears the shade entry — "ready" because setup is done, the rest because
  // a stalled/blocked download showing "in progress" forever would be a lie.
  if (lastShownPercent === -1) {
    return;
  }
  await Notifications.dismissNotificationAsync(NOTIFICATION_ID).catch(() => {});
  if (seq === latestSeq) {
    lastShownPercent = -1;
  }
}

/** Call with the latest `ModelDownloadStatus` on every status change —
 * safe to call as often as `setStatus` itself fires; internally sequenced
 * (see the long comment above) and never throws. */
export function syncDownloadNotification(status: ModelDownloadStatus): void {
  const seq = ++latestSeq;
  void applyStatus(status, seq);
}
