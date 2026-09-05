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

async function ensureChannel(): Promise<void> {
  if (channelReady || Platform.OS !== "android") {
    return;
  }
  channelReady = true;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Model setup",
    importance: Notifications.AndroidImportance.LOW,
    vibrationPattern: null,
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

async function showOrUpdate(status: ModelDownloadStatus): Promise<void> {
  await ensureChannel();
  const granted = await ensurePermission();
  if (!granted) {
    return;
  }
  const percent = Math.round(status.progressPercent);
  await Notifications.scheduleNotificationAsync({
    identifier: NOTIFICATION_ID,
    content: {
      title: "Setting up Xayra",
      body: `Downloading in progress... ${percent}% of 100%`,
      sticky: true,
      autoDismiss: false,
      ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
    },
    trigger: null,
  });
  lastShownPercent = percent;
}

async function dismiss(): Promise<void> {
  await Notifications.dismissNotificationAsync(NOTIFICATION_ID).catch(() => {});
  lastShownPercent = -1;
}

/** Call with the latest `ModelDownloadStatus` on every status change —
 * safe to call as often as `setStatus` itself fires; internally throttled
 * and never throws. */
export function syncDownloadNotification(status: ModelDownloadStatus): void {
  if (status.status === "downloading") {
    const percent = Math.round(status.progressPercent);
    if (percent === lastShownPercent) {
      return;
    }
    void showOrUpdate(status);
    return;
  }
  // Every other state (ready, error, idle, cellular_blocked, paused_offline)
  // clears the shade entry — "ready" because setup is done, the rest because
  // a stalled/blocked download showing "in progress" forever would be a lie.
  if (lastShownPercent !== -1) {
    void dismiss();
  }
}
