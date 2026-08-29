import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import { showToast } from "../components/Toast";

/** Copies `text` to the system clipboard, fires a subtle success haptic, and
 * surfaces a brief "Copied to clipboard" toast — the single call site used
 * by every long-press-to-copy interaction (chat bubbles, note cards, the
 * note detail sheet) so all three stay behaviorally identical rather than
 * each screen wiring up its own copy feedback.
 *
 * Silently no-ops on blank text — copying an empty bubble/note body isn't a
 * real user action, just an easy way to accidentally clear the clipboard.
 */
export async function copyTextWithFeedback(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  await Clipboard.setStringAsync(trimmed);
  // Haptics can fail on devices/emulators without a vibration motor —
  // that's not a reason to skip the copy or the toast that confirms it.
  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  showToast("Copied to clipboard");
}
