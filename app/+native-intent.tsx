import { parseShortcutUrl, setPendingShortcut } from "../services/shortcuts/launchShortcut";

/**
 * Expo Router's hook for every incoming system link (cold start and while
 * running). A launcher shortcut link (`<scheme>://shortcut?mode=…`, see
 * plugins/withAppShortcuts.js) becomes a pending shortcut that Home acts
 * on, and routes to Home — there is no "shortcut" screen. Every other link
 * passes through unchanged.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const mode = parseShortcutUrl(path);
  if (!mode) return path;
  setPendingShortcut(mode);
  return "/";
}
