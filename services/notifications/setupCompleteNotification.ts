import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

// Side-effect import — registers the one app-wide `setNotificationHandler`
// call. See notificationHandler.ts's own doc comment for why this can't
// just be an inline `Notifications.setNotificationHandler(...)` call here.
import "./notificationHandler";

/**
 * The "One Door, Opens Once" onboarding screen's completion signal — see
 * screens/OnboardingSetupScreen.tsx. Deliberately the OPPOSITE of
 * downloadNotification.ts's silent progress mirror: this is the one moment
 * in the whole setup flow actually worth interrupting the user for (they may
 * have minimized the app per the onboarding screen's own instructions), so
 * it gets its own channel with sound and banner visibility rather than
 * reusing the silent "model-download" channel.
 *
 * By the time this fires, `markSetupComplete()` has already run (see
 * services/settings/appSettings.ts), so tapping the notification just needs
 * to open the app normally — app/_layout.tsx's root guard reads the
 * already-true flag on that launch and renders the normal home screen
 * directly, no special deep-link/tap-handler plumbing required (unlike
 * todoNotifications.ts's tap-to-open, which has to route to a specific
 * screen instead of wherever the app would land anyway).
 */
const CHANNEL_ID = "setup-complete";
const NOTIFICATION_ID = "xayra-setup-complete";

let channelReady = false;

async function ensureChannel(): Promise<void> {
  if (channelReady || Platform.OS !== "android") {
    return;
  }
  channelReady = true;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Setup complete",
    importance: Notifications.AndroidImportance.HIGH,
    showBadge: false,
  }).catch(() => {
    channelReady = false;
  });
}

/**
 * Fires once, when the onboarding flow's real work (whisper, embeddings,
 * Llama chat model all on disk) finishes. A missing/denied notification
 * permission is a soft failure, same as downloadNotification.ts — the
 * onboarding screen itself already shows the "ready" state regardless of
 * whether this notification actually lands, matching this app's rule that
 * notifications are never a dependency of the underlying feature.
 */
export async function showSetupCompleteNotification(): Promise<void> {
  await ensureChannel();
  const existing = await Notifications.getPermissionsAsync().catch(() => null);
  const granted = existing?.granted || (await Notifications.requestPermissionsAsync().catch(() => null))?.granted;
  if (!granted) {
    return;
  }
  await Notifications.scheduleNotificationAsync({
    identifier: NOTIFICATION_ID,
    content: {
      title: "Xayra is ready for you! ✨",
      body: "Your private memory vault is set up. Tap to capture your first thought!",
      data: { kind: "setup-complete" },
      sound: true,
      priority: Notifications.AndroidNotificationPriority.HIGH,
    },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  }).catch(() => {});
}
