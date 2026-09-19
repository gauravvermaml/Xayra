@AGENTS.md

# Xayra — Project Context & Developer Guidelines

## Architecture

- **Framework**: React Native via Expo (SDK 57), TypeScript (`strict: true`), Expo Router (file-based routing under `app/`).
- **Native modules that require a compiled dev client** — Metro/JS-only changes are NOT enough for any of these; a real native build is required after touching them (see below):
  - `@op-engineering/op-sqlite` — encrypted SQLite (SQLCipher) with `sqlite-vec` (vector search) and FTS5 (keyword search) compiled in. Enabled via the `"op-sqlite"` block in `package.json` (`sqliteVec`, `fts5`).
  - `whisper.rn` — whisper.cpp binding, on-device speech-to-text.
  - `onnxruntime-react-native` — ONNX Runtime binding, on-device embeddings.
  - `llama.rn` — llama.cpp binding, on-device LLM inference.
  - `expo-speech` — native Android TextToSpeech engine.
  - `expo-local-authentication` / `expo-secure-store` — biometric-gated database encryption key storage.

## Directory layout

- `app/` — Expo Router screens (`index.tsx` = Notes tab, `chat.tsx` = Chat/RAG tab).
- `services/ai/` — local-first AI: `localWhisper.ts`, `localEmbeddings.ts`, `tokenizer.ts` (from-scratch BERT WordPiece), `localLlama.ts` (also owns the shared llama.cpp completion priority queue — `"interactive"` RAG answers jump ahead of any not-yet-started `"background"` extraction job), `rag.ts`, `transformationEngine.ts` (Llama-based To-Do extraction from note text, GBNF-grammar-constrained, with a `chrono-node` pre-pass and a thermal-status check that defers firing while the device reports itself hot — see its own doc comments for the extraction pipeline's history), `modelDownloadManager.ts` (onboarding downloads, retired-model cleanup, and the measured thread-escalation trial — the old adaptive 1B→3B *model* tier ladder was removed in Build 47's single-model cutover), `modelPerformanceTracker.ts` (rolling real-completion-throughput samples the thread-escalation decision reads). (The legacy OpenAI-backed `whisper.ts`/`embeddings.ts` and their `config/env.ts` — unreferenced by any live path and requiring an `EXPO_PUBLIC_`-prefixed key that Metro would have inlined into the client bundle — were deleted as a security cleanup; see git history if that reference implementation is ever needed again.)
- `services/audio/` — recording (`recorder.ts`), playback (`player.ts`), TTS (`tts.ts`), each a single-instance singleton so only one audio source is ever active app-wide.
- `services/notes/noteManager.ts` — note CRUD and hybrid (vector + FTS5, reciprocal-rank-fusion) search.
- `services/todos/todoManager.ts` — "Your To-Dos" CRUD, recurrence/interval respawn logic (`completeToDo()`, `computeNextActionDate()`).
- `services/notifications/` — `notificationHandler.ts` (the one app-wide `expo-notifications` `setNotificationHandler` call — see its own doc comment for why every notification feature must import this rather than calling `setNotificationHandler` itself), `downloadNotification.ts` (silent model-setup-progress mirror), `todoNotifications.ts` (a to-do's own local reminder — schedule/cancel, tap-to-open pub/sub), `setupCompleteNotification.ts` (the one audible "Xayra is Ready!" alert at the end of onboarding).
- `services/crypto/keyManager.ts` — database encryption key lifecycle (SecureStore, biometric-gated where enrolled).
- `services/settings/` — `preferences.ts` (JSON-file runtime state: cellular-download consent, in-flight native download IDs, model-performance samples, thread-escalation trial status) and `appSettings.ts` (SQLite key/value table for durable one-time app milestones — currently just `setup_complete`; deliberately a separate mechanism from `preferences.ts`, see its own doc comment for why).
- `db/` — `schema.ts` (Drizzle schema plus raw `vec0`/`fts5` SQL — drizzle-kit has no first-class virtual-table support) and `client.ts` (connection, dimension-migration logic).
- `modules/` — small local Expo native modules, following the same pattern each time (`package.json` with a `file:` reference from root `package.json`, `expo-module.config.json`, a thin Kotlin `Module`): `app-signature/` (release-signature verification), `device-cpu/` (`Runtime.getRuntime().availableProcessors()` for inference thread sizing, plus `PowerManager.getCurrentThermalStatus()` so background AI work can defer itself when the device is already hot), and `download-bridge/` (hands a large model download to Android's own system `DownloadManager` service so it survives this app's process being backgrounded/killed mid-transfer — see `services/ai/modelDownloadManager.ts`).
- `patches/` — `patch-package` fixes for native dependencies with broken Gradle scripts (see Coding Standards).

## Build, typecheck & native rebuild

Standard verification loop after any change:

```
npx tsc --noEmit
npx expo export --platform android
```

These only validate TypeScript and JS bundling — they do **not** prove native code still links. After touching any native dependency (installing/upgrading `whisper.rn`, `onnxruntime-react-native`, `llama.rn`, `op-sqlite`, `expo-speech`, or editing anything under `patches/`), a real native build is required:

```
npx expo prebuild --clean --no-install
npx expo run:android
```

**Environment notes for this machine (Windows)**:
- `JAVA_HOME` must point at JDK 17 (`~/.gradle/jdks/eclipse_adoptium-17-amd64-windows.2`, auto-provisioned by Gradle) before any native/`gradlew` build — the system default JDK (25, JetBrains Runtime) is too new for the current Android Gradle Plugin's native CMake step.
- Run `npm install` for any package with a native-artifact-download postinstall step (anything that shells out to `tar`, e.g. `llama.rn`) through **PowerShell**, not the Bash/Git-Bash tool — Git Bash's `tar` is MSYS's GNU tar, which doesn't understand Windows drive letters and misparses `C:\...` paths as a remote `host:path` spec, causing the download step to fail.

**Troubleshooting**: if a dev build installs successfully but the app hangs on a blank white/black screen, the Metro dev server has likely gone unresponsive (this happens after it's been kept running across many rebuilds in one session — sometimes with a corrupted on-disk cache) rather than anything being wrong with the build itself. Confirm with a quick `curl http://localhost:8081/status` (it'll hang instead of responding), then restart Metro with `npx expo start --clear` (the `--clear` flag also discards a stale/corrupted transform cache), re-run `adb reverse tcp:8081 tcp:8081`, and cold-launch the app via its dev-client deep link rather than the plain launcher icon.

**Troubleshooting — a new SQLite migration silently doesn't apply after Fast Refresh**: `db/client.ts` deliberately caches its `op-sqlite` connection on `globalThis` (not a plain module-scoped variable) specifically so Fast Refresh doesn't repeatedly re-open/re-key the encrypted database on every edit. The tradeoff: `createCoreTables()`'s idempotent `ALTER TABLE ... ADD COLUMN` migrations only ever run once per real app **process**, not once per JS reload — editing `db/schema.ts`/`db/client.ts` to add a new column and then testing via Fast Refresh will hit `sqlite query error: no such column: <new column>` on the already-open connection, even though the migration code itself is correct. Fix: fully kill and relaunch the app (`adb shell am force-stop <package>` then relaunch, or swipe it away in the recents UI on-device) — a real process restart resets `globalThis` and lets `openDatabase()` run `createCoreTables()` fresh, picking up the new migration. A plain "Reload JS" from the dev menu is not reliably enough on its own; a full process kill is the only guaranteed fix.

## Local AI model assets

None of the model files are bundled into the app or downloaded automatically — they're tens to hundreds of MB and would bloat every build. Each is resolved at runtime from `FileSystem.documentDirectory` and must be pushed there manually before its corresponding feature will work; every service throws a clear, specific error naming the missing file rather than failing silently.

| File | Used by | Powers |
|---|---|---|
| `ggml-tiny.en.bin` (or `ggml-base.en.bin`) | `services/ai/localWhisper.ts` | Voice note & chat-query transcription |
| `bge-small-en-v1.5-quantized.onnx` | `services/ai/localEmbeddings.ts` | 384-d vector embeddings |
| `bge-small-en-v1.5-vocab.txt` | `services/ai/tokenizer.ts` | WordPiece tokenizer vocab for the embedding model |
| `qwen2.5-1.5b-instruct-q4_k_m.gguf` | `services/ai/localLlama.ts` | RAG chat answer generation + to-do extraction |

See the README's setup section for the exact `adb push` commands.

## Coding standards

- **Modular services, one responsibility per file.** No screen component talks to `op-sqlite`, `whisper.rn`, `onnxruntime-react-native`, or `llama.rn` directly — go through the relevant `services/` module.
- **Explicit TypeScript types everywhere.** `strict: true` stays on. Don't reach for `any` as an escape hatch for a wrong/missing third-party type — fix it with a narrow, documented workaround instead (e.g. `tsconfig.json`'s `paths` override redirecting `whisper.rn/index` to its real `.d.ts`, needed because of an upstream `exports`-map gap).
- **Zero-cloud-API dependency for the core loop.** Transcription, embedding, search, and RAG answer generation must never require a network call or an API key — that's this app's entire premise. A feature that needs a network call must be optional and clearly separated from the offline core loop, never a silent dependency of it.
- **`patch-package` hygiene**: if a native dependency's Gradle/build script is broken — has happened twice so far (`whisper.rn`'s autolinking dependency name, `onnxruntime-react-native`'s use of a Gradle API class removed in Gradle 9.x) — fix it directly in `node_modules`, then run `npx patch-package <name>`. **Clean native build-cache output first**, or the generated patch balloons to hundreds of files of CMake cache noise:
  ```
  rm -rf node_modules/<pkg>/android/.cxx node_modules/<pkg>/android/build
  npx patch-package <name>
  ```
  The `postinstall` script (`patch-package`) reapplies every patch in `patches/` automatically on `npm install` — verify a fix survives a clean reinstall before considering it done.
- **Verify package provenance before installing anything a task brief names.** This project has twice been asked to install a package that turned out not to exist (`react-native-llama`, 404) or to be an abandoned placeholder (`react-native-whisper`, a single stale `0.0.1` release). Check npm version history, maintainer, and publish cadence first — the real, actively-maintained equivalents (`llama.rn`, `whisper.rn`) are both from the same publisher (`mybigday`).
- **Prefer specific `git add <files>` over `git add .` / `git add -A`.** This repo accumulates untracked local build logs (`*.log` from `expo prebuild`/`run:android`) that don't belong in commits.
