import * as Notifications from "expo-notifications";

/**
 * `Notifications.setNotificationHandler()` accepts exactly ONE handler for
 * the whole app — calling it a second time from a different module doesn't
 * compose with the first, it silently REPLACES it, since expo-notifications
 * just holds one module-level reference to whichever handler was set most
 * recently. This app has two notification "kinds" that genuinely need
 * different foreground behavior:
 *   - downloadNotification.ts's silent setup-progress mirror (no banner, no
 *     sound, ever — see its own doc comment for why).
 *   - todoNotifications.ts's actual reminder alerts (banner + sound —
 *     these exist specifically to interrupt the user at the right moment).
 * Registering the ONE handler this whole app is allowed to have here, and
 * having both feature files import this module for its side effect rather
 * than each calling `setNotificationHandler` itself, means which behavior
 * "wins" is never a silent function of import order — it's an explicit
 * branch on what's actually being shown.
 */
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const kind = notification.request.content.data?.kind;
    // todo-reminder (todoNotifications.ts) and setup-complete
    // (setupCompleteNotification.ts) are the two kinds actually worth
    // interrupting the user for — everything else falls through to
    // downloadNotification.ts's silent progress-mirror default below.
    if (kind === "todo-reminder" || kind === "setup-complete") {
      return {
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      };
    }
    // Default: downloadNotification.ts's silent progress-mirror behavior.
    return {
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});
