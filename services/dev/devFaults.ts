import * as FileSystem from "expo-file-system/legacy";

import { isRunningDevPackage } from "./disposableVault";

/**
 * Development-only fault injection for crash and failure tests (Xayra Dev /
 * Xayra Test packages only; production never reads the file).
 * files/dev-<scope>-fault.json: { "failAt": "<step>" } throws at that step;
 * { "pauseAfter": "<step>" } hangs there so the process can be killed.
 * Read once per process.
 */
type Spec = { failAt?: string; pauseAfter?: string; wrongKeyAt?: string };
const specs = new Map<string, Promise<Spec | null>>();

function load(scope: string): Promise<Spec | null> {
  let pending = specs.get(scope);
  if (!pending) {
    pending = (async () => {
      if (!isRunningDevPackage()) return null;
      const uri = `${FileSystem.documentDirectory}dev-${scope}-fault.json`;
      try {
        if (!(await FileSystem.getInfoAsync(uri)).exists) return null;
        return JSON.parse(await FileSystem.readAsStringAsync(uri)) as Spec;
      } catch {
        return null;
      }
    })();
    specs.set(scope, pending);
  }
  return pending;
}

export async function devFailAt(scope: string, step: string): Promise<void> {
  if ((await load(scope))?.failAt === step) {
    console.log(`[DevFault] ${scope} failing at ${step}`);
    throw new Error(`Injected failure at ${step}`);
  }
}

export async function devPauseAfter(scope: string, step: string): Promise<void> {
  if ((await load(scope))?.pauseAfter === step) {
    console.log(`[DevFault] ${scope} paused after ${step}`);
    await new Promise<never>(() => undefined);
  }
}

/** True when the test asks for a wrong key at this step. */
export async function devWrongKeyAt(scope: string, step: string): Promise<boolean> {
  const hit = (await load(scope))?.wrongKeyAt === step;
  if (hit) console.log(`[DevFault] ${scope} using a wrong key at ${step}`);
  return hit;
}
