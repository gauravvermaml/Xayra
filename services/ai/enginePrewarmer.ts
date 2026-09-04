import { getRawDatabase } from "../../db/client";
import { prewarmLocalLlama } from "./localLlama";

let prewarmStarted = false;

/**
 * Silent, best-effort background warm-up of every engine the first real
 * note-save or RAG query would otherwise have to cold-start: opens the
 * SQLCipher connection (which is also where `sqlite-vec`/FTS5 get loaded —
 * see db/client.ts's getConnection), and loads the Llama GGUF model into
 * native memory. Each step is independent and swallows its own failure —
 * a device that hasn't finished downloading the chat model yet should still
 * get the SQLite warm-up, and vice versa. Call once from app/index.tsx on
 * mount; idempotent so re-mounts (Fast Refresh, navigating back) don't
 * repeat the work.
 */
export function prewarmEngines(): void {
  if (prewarmStarted) {
    return;
  }
  prewarmStarted = true;

  void getRawDatabase().catch((err) => {
    console.warn("[EnginePrewarmer] SQLite/vec warm-up skipped:", err instanceof Error ? err.message : err);
  });

  // Deliberately not awaited/chained after the DB warm-up above — the two
  // are unrelated engines and should warm up in parallel, not one blocking
  // the other's start.
  void prewarmLocalLlama();
}
