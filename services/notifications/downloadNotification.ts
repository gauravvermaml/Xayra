import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

import type { ModelDownloadStatus } from "../ai/modelDownloadManager";
// Side-effect import — registers the one app-wide `setNotificationHandler`
// call. See notificationHandler.ts's own doc comment for why this can't
// just be an inline `Notifications.setNotificationHandler(...)` call in
// this file anymore now that services/notifications/todoNotifications.ts
// also needs a say in the same handler.
import "./notificationHandler";

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

/** Build 27 PROGRESS UPDATE THROTTLING: `setStatus` fires on every ~250ms
 * progress tick (see modelDownloadManager's MIN_SAMPLE_INTERVAL_MS) — posting
 * a real native `scheduleNotificationAsync` call that often is what was
 * actually choking the Android notification queue and freezing progress on
 * screen at a stale percentage (observed on-device stuck at 91%). An update
 * now only reaches the native API when the rounded percent has moved by at
 * least `PERCENT_STEP_THRESHOLD` (5) since the last one actually shown, OR
 * `MIN_UPDATE_INTERVAL_MS` (3s) has elapsed since then — whichever comes
 * first, so a slow download still visibly ticks even between 5%-sized jumps. */
const PERCENT_STEP_THRESHOLD = 5;
const MIN_UPDATE_INTERVAL_MS = 3000;
let lastShownPercent = -1;
let lastShownAtMs = 0;
let channelReady = false;
let permissionRequested = false;

/**
 * Build 26 SILENT DOWNLOAD NOTIFICATION: no heads-up popover, no vibration,
 * ever — a background model download is not an event worth interrupting the
 * user for, only a status they can glance at in the shade if they choose to
 * pull it down. `sound: null` and `vibrationPattern: []`/`enableVibrate:
 * false` close the sound/vibration gap explicitly rather than relying on the
 * importance level alone.
 *
 * Build 27: importance dropped from `LOW` to `MIN` — `MIN` is what actually
 * puts a notification in Android's collapsed "Silent" section of the shade
 * alongside other system alerts (no status-bar icon, no visual weight), which
 * is a better match for "quietly informational" than `LOW` (still shown
 * expanded, just without a heads-up popup). `showBadge: false` here is the
 * channel-level half of DISABLE LAUNCHER APP BADGE — paired with
 * `shouldSetBadge: false` in the global handler and `badge: 0` per-post below.
 */
async function ensureChannel(): Promise<void> {
  if (channelReady || Platform.OS !== "android") {
    return;
  }
  channelReady = true;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Model setup",
    importance: Notifications.AndroidImportance.MIN,
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
    // PROGRESS UPDATE THROTTLING: only reaches the native API on a real
    // step (>= 5 percentage points since the last shown update) or after
    // MIN_UPDATE_INTERVAL_MS has elapsed — see the constants' own doc
    // comment above for why. `lastShownPercent === -1` (nothing shown yet
    // this download) always passes, so the first update is never throttled.
    const percentStep = Math.abs(percent - lastShownPercent);
    const elapsedSinceShown = Date.now() - lastShownAtMs;
    const shouldPost =
      lastShownPercent === -1 || percentStep >= PERCENT_STEP_THRESHOLD || elapsedSinceShown >= MIN_UPDATE_INTERVAL_MS;
    if (!shouldPost) {
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
        // `badge: 0` is the per-post half of DISABLE LAUNCHER APP BADGE —
        // see the global handler's `shouldSetBadge: false` and the
        // channel's `showBadge: false` for the other two layers of it.
        sticky: true,
        autoDismiss: false,
        sound: false,
        vibrate: [],
        badge: 0,
        priority: Notifications.AndroidNotificationPriority.LOW,
      },
      // Real bug, found on-device: `channelId` was previously spread into
      // `content` above — but `NotificationContentInput` has no such field
      // at all (confirmed against expo-notifications' own types). TypeScript
      // never caught the excess property because it was added via a
      // conditional spread (`...(cond ? {channelId} : {})`), which suppresses
      // the usual excess-property check on object literals. The value was
      // silently dropped on every single post, so every notification this
      // app has ever sent landed on Android's auto-created
      // "expo_notifications_fallback_notification_channel" instead of our
      // silent "model-download" one — which defaults to HIGH importance,
      // vibration enabled, and a default sound, exactly matching the
      // on-device symptom (buzzing + heads-up popups) despite the
      // "model-download" channel itself being correctly configured as
      // silent (confirmed via `adb shell dumpsys notification`). The correct
      // place for the channel on an immediate (non-scheduled) notification is
      // the TRIGGER, not the content — `{ channelId }` is expo-notifications'
      // own `ChannelAwareTriggerInput`, documented as "deliver immediately"
      // while carrying the channel, replacing the old `trigger: null`.
      trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
    });
    if (seq === latestSeq) {
      lastShownPercent = percent;
      lastShownAtMs = Date.now();
    }
    return;
  }
  // AUTO-DISMISS ON COMPLETION: every other state (ready, error, idle,
  // cellular_blocked, paused_offline) immediately clears the shade entry —
  // "ready" because setup is done (the moment progress conceptually reaches
  // 100%, whether or not a "100%" update was itself ever posted, thanks to
  // throttling above), the rest because a stalled/blocked download showing
  // "in progress" forever would be a lie.
  if (lastShownPercent === -1) {
    return;
  }
  await Notifications.dismissNotificationAsync(NOTIFICATION_ID).catch(() => {});
  if (seq === latestSeq) {
    lastShownPercent = -1;
    lastShownAtMs = 0;
  }
}

/** Call with the latest `ModelDownloadStatus` on every status change —
 * safe to call as often as `setStatus` itself fires; internally sequenced
 * (see the long comment above) and never throws. */
export function syncDownloadNotification(status: ModelDownloadStatus): void {
  const seq = ++latestSeq;
  void applyStatus(status, seq);
}
