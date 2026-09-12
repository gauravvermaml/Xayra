import { getRawDatabase } from "../../db/client";
import { prewarmLocalLlama } from "./localLlama";
import { prewarmLocalWhisper } from "./localWhisper";

let prewarmStarted = false;

/**
 * Silent, best-effort background warm-up of every engine the first real
 * note-save or RAG query would otherwise have to cold-start: opens the
 * SQLCipher connection (which is also where `sqlite-vec`/FTS5 get loaded —
 * see db/client.ts's getConnection), loads the Llama GGUF model into native
 * memory, and (added after a tester's "first note still feels slow"
 * report, root-caused to Whisper being the one engine this function never
 * warmed) loads the Whisper GGML model too. Each step is independent and
 * swallows its own failure — a device that hasn't finished downloading one
 * model yet should still get the others' warm-up. Call once from
 * app/index.tsx on mount; idempotent so re-mounts (Fast Refresh, navigating
 * back) don't repeat the work.
 */
export function prewarmEngines(): void {
  if (prewarmStarted) {
    return;
  }
  prewarmStarted = true;

  void getRawDatabase().catch((err) => {
    console.warn("[EnginePrewarmer] SQLite/vec warm-up skipped:", err instanceof Error ? err.message : err);
  });

  // Deliberately not awaited/chained off one another — all three are
  // unrelated engines and should warm up in parallel, not serialize behind
  // each other's cold-start cost.
  void prewarmLocalLlama();
  void prewarmLocalWhisper();
}
