/**
 * Single source of truth for the Cloudflare Worker that proxies every local
 * model file (Whisper Base, the Llama chat model) — a tiny standalone module
 * rather than exported from modelDownloadManager.ts so whisperModels.ts can
 * import it without creating a modelDownloadManager.ts <-> whisperModels.ts
 * import cycle (modelDownloadManager.ts already imports from whisperModels.ts).
 *
 * Verified live (not just assumed) before wiring this in: `curl -I` against
 * all three endpoints returns 200, byte-range requests return 206, and a
 * real (non-HEAD) GET returns a correct `Content-Length` matching the known
 * file sizes — the Worker's HEAD handler omits `Content-Length`, but
 * `expo-file-system`'s downloader issues a real GET, so progress/total-size
 * reporting works correctly in practice.
 */
export const MODEL_CDN_BASE_URL = "https://xayra-models-proxy.vermagauravsingh.workers.dev";
