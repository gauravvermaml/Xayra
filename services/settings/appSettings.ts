import { getRawDatabase } from "../../db/client";

/**
 * Flags backed by db/schema.ts's `app_settings` key/value table — see its
 * own doc comment for why this is a separate mechanism from
 * services/settings/preferences.ts's JSON file. Add new keys here rather
 * than inventing another storage location.
 */
const SETUP_COMPLETE_KEY = "setup_complete";

/**
 * Whether the "One Door, Opens Once" onboarding flow (app/_layout.tsx's root
 * guard) has ever finished — TRUE once, forever, the first time Whisper,
 * the embedding model, and the Llama chat model have all landed on disk.
 * Never re-checked against the files themselves on subsequent launches: a
 * user who later clears the model files some other way is a different,
 * unrelated failure mode (every service already throws a clear "model file
 * missing" error of its own), not a reason to force this user back through
 * onboarding.
 */
export async function isSetupComplete(): Promise<boolean> {
  const db = await getRawDatabase();
  const result = await db.execute("SELECT value FROM app_settings WHERE key = ?", [SETUP_COMPLETE_KEY]);
  return result.rows[0]?.value === "true";
}

/** Idempotent — safe to call more than once (e.g. a resumed setup flow that
 * re-runs its completion step). */
export async function markSetupComplete(): Promise<void> {
  const db = await getRawDatabase();
  await db.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", [SETUP_COMPLETE_KEY, "true"]);
}
