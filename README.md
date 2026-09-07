# Xayra

**A private, local-first memory recall assistant.**

Record a voice note or type one. It's transcribed, embedded, and indexed — entirely on your phone. Ask a question and get a spoken, cited answer grounded in your own notes — entirely on your phone. No cloud API, no account, no network call, ever, in the core loop.

*(Formerly built and shipped internally as "Silent Confidant," then "Remi," before the full rebrand to Xayra.)*

---

## Product Overview & Aesthetic

As of Build 26, Xayra is a single unified canvas — there is no separate Notes/Chat tab pair. Everything happens on one Apple-Maps-inspired screen:

- **True jet-black (`#000000`) canvas.** Not the app's older charcoal (`#0E0F12`) design system — the recording surface itself is pure black so a [`@gorhom/bottom-sheet`](https://github.com/gorhom/react-native-bottom-sheet) sitting over it (also `#000000`) reads as one continuous surface, the same visual trick Apple Maps uses for its search sheet over the map.
- **A 1.3× central logo button** (`components/CentralRecorderCanvas.tsx`) — the Xayra emblem + wordmark (`assets/xayra-logo.png`), clipped to a circle, that scales further (up to +6%) in real time while recording, driven by live microphone RMS amplitude, not a canned animation.
- **A stateful RMS waveform** — a row of bars around the button whose heights are driven by the same real amplitude reading (`services/audio/recorder.ts`'s `amplitude`, computed in `services/audio/wav.ts`'s `computeRms`), smoothed with a Reanimated shared-value sine wave rather than jumping frame-to-frame. Idle and recording are visually distinct states, not just a hidden/shown toggle.
- **One sticky bottom sheet, capped at two snap points** (`20% / 50%`, `components/HistorySheet.tsx`) — a resting "peek" showing just a drag handle and the sticky compose bar, and a single expanded stage (shared by "an answer is streaming in" and "browsing history") showing a `Recorded notes | Searched notes` segmented control. There used to be a third, 90% stage; it was removed outright — a user's own drag gesture could reach it regardless of what the app snapped to programmatically, which pushed content into the status bar.
- **One text-entry surface** (`components/ComposeBar.tsx`), living inside the sheet as its sticky header (with the settings cogwheel on its right), used identically whether you're typing or the transcript came from voice.
- **An explicit `[ Record | Ask ]` mode pill**, floating with a `🎧 Handsfree` toggle above the drawer — see [Explicit Mode Routing](#explicit-mode-routing) below.

## AI & Data Architecture (100% On-Device)

Every stage of the pipeline below runs on-device. Nothing in it makes a network request.

```
  🎙️  Voice Recording (@fugood/react-native-audio-pcm-stream)
         │  raw PCM + live RMS amplitude
         ▼
  ┌─────────────────────────┐
  │   Local Whisper STT     │   whisper.rn (whisper.cpp C++ bindings)
  │   ggml-*.bin  (GGML)    │   — fully on-device transcription
  └─────────────────────────┘
         │  transcript text
         ▼
  ┌─────────────────────────────────────┐
  │  Explicit Record/Ask routing        │   app/index.tsx (inputMode state)
  │  — no classification, no model call │   set only by the user's own tap
  └─────────────────────────────────────┘
         │                      │
   RECORD│                      │ASK
         ▼                      ▼
  ┌─────────────────┐   ┌────────────────────────────┐
  │ Local ONNX       │   │  Hybrid Retrieval (RRF)     │
  │ Embedding        │   │  vector cosine + FTS5 bm25  │
  │ bge-small-en-v1.5│   └────────────────────────────┘
  │ 384-dim vector   │                │  top-K notes
  └─────────────────┘                 ▼
         │                  ┌───────────────────────────┐
         ▼                  │  <context><note>…</note>  │
  ┌─────────────────────┐   │  </context>  (XML block)  │
  │ sqlite-vec (vec0)   │   └───────────────────────────┘
  │ + FTS5 keyword idx  │                │
  │ on op-sqlite/       │                ▼
  │ SQLCipher storage   │   ┌───────────────────────────┐
  └─────────────────────┘   │   Local Llama GGUF LLM     │  llama.rn (llama.cpp)
                             │   Instruct-template prompt │  — streamed token-by-token
                             │   Q4_K_XL quantized        │  — [Note N] citations
                             └───────────────────────────┘
                                          │  streamed answer text
                                          ▼
                             ┌───────────────────────────┐
                             │  Native TTS (expo-speech)  │  — hands-free playback
                             └───────────────────────────┘
```

### Speech-to-Text
[`whisper.rn`](https://github.com/mybigday/whisper.rn) binds whisper.cpp's C++ engine directly into the app; `services/ai/localWhisper.ts` resolves a `ggml-tiny.en.bin` (preferred, lower latency) or `ggml-base.en.bin` model from the document directory and transcribes both recorded voice notes and spoken chat queries.

### Intent & Reasoning
`services/ai/localLlama.ts` runs a quantized Llama 3.2 Instruct GGUF model via [`llama.rn`](https://github.com/mybigday/llama.rn) (llama.cpp). Two sizes are supported — a 1B and a 3B variant, both `-UD-Q4_K_XL.gguf` (Unsloth Dynamic quantization) — and `services/ai/modelDownloadManager.ts` fetches whichever one fits the device's RAM tier (see [Hardware Requirements](#hardware-requirements--constraints)). If both happen to be present on disk, the 3B is preferred.

### Explicit Mode Routing
Earlier builds (through Build 21) classified every submission automatically via a two-stage regex + Llama micro-prompt router (`services/ai/intentRouter.ts`). As of Build 22, that file — and its Llama-side half, `classifyIntentWithLlama()` in `services/ai/localLlama.ts` — is **deleted**, not just unused. Routing is now 100% deterministic: an explicit `[ Record | Ask ]` pill (floating above the drawer, synced with which drawer segment is showing) is the single source of truth for what a submission does, set only by the user's own tap. `RECORD` always saves a note (SQLite + vector index, zero RAG calls); `ASK` always runs retrieval + generation (zero note writes) — never both, never a guess. This is a deliberate product reversal, not a bug fix: automatic classification traded away the occasional wrong guess on ambiguous input (e.g. "do laundry" vs. "did I do laundry") for convenience; the explicit pill trades that convenience back for the user always knowing exactly what a submission will do before they make it.

### Vector RAG Storage
[`@op-engineering/op-sqlite`](https://github.com/OP-Engineering/op-sqlite) (`op-sqlite.sqliteVec: true` / `op-sqlite.fts5: true` in `package.json`) provides an encrypted (SQLCipher) SQLite database with [`sqlite-vec`](https://github.com/asg017/sqlite-vec) compiled in as a `vec0` virtual table alongside an FTS5 virtual table (`db/schema.ts`). `services/notes/noteManager.ts` fuses vector cosine similarity and FTS5 bm25 keyword results via reciprocal rank fusion for hybrid retrieval — the top-K notes are injected into the Llama prompt as an XML `<context>` block, with `[Note N]` citations enforced by the system prompt.

## High-Performance Infrastructure

### Model Streaming
None of the model files (whisper GGML, ONNX embedding model, Llama GGUF — tens of MB to ~2GB) are bundled into the app or downloaded automatically at every launch. When a feature is first used, `services/ai/modelDownloadManager.ts` streams the required file directly to disk using `expo-file-system`'s native `createDownloadResumable()` — a true OS-level background download, not a hand-rolled `fetch()` + JS-heap buffer loop, so multi-hundred-MB files never risk an out-of-memory crash from holding the whole download in JS memory at once. Downloads are pausable/resumable, survive an airplane-mode drop with automatic reconnect, and are backed by an explicit keep-awake lock (`expo-keep-awake`) so the screen sleeping mid-download doesn't stall it.

Files are fetched from a **Cloudflare Worker CDN proxy** (`services/ai/modelCdn.ts`'s `MODEL_CDN_BASE_URL`) rather than hitting Hugging Face or an R2 bucket directly from the client.

Progress is surfaced two ways at once, both fed by the same `modelDownloadManager.ts` status:
- **In-app** — `components/ModelDownloadCard.tsx`, rendered in natural flex flow in the drawer beneath whichever list is showing ("Downloading in progress... N% of 100%"), with explicit spacing so its text never collides with the Android nav bar.
- **Notification shade** — `services/notifications/downloadNotification.ts` mirrors the same progress there, so it stays visible even while Xayra isn't the foreground app. The channel is `MIN` importance with `sound: null`/`vibrationPattern: []`/`enableVibrate: false` at the channel level and repeated per-notification (`sound: false`, `vibrate: []`, `badge: 0`) — confirmed on-device sitting quietly under the shade's own "Silent" section, no heads-up popup, no vibration, no launcher badge. Updates are throttled to at most one native post per 5-percentage-point step or 3 seconds, whichever comes first, and the channel is passed via the notification's `trigger` (`{ channelId }`) rather than its `content` — the latter has no such field, and an earlier attempt that put it there was silently dropped, landing every notification on Android's noisy default fallback channel instead.

The moment a model finishes downloading (or is found already on disk at boot), `services/ai/localLlama.ts`'s `prewarmLocalLlama()` loads the GGUF context **and** runs one silent, throwaway 1-token completion — llama.cpp's KV-cache/thread-pool spin-up is otherwise lazily deferred to the first real generation call, which is what used to make a user's first "Ask" after setup noticeably slower than every one after it. By the time the user actually asks something, the context is already fully hot. Every call site funnels through one deduplicated in-flight promise (the same pattern the context loader itself uses), so the app-boot warm-up and the "download just finished" warm-up can never race each other into calling the native completion API twice at once.

## Hardware Requirements & Constraints

Running Whisper transcription and a multi-hundred-MB-to-multi-GB Llama context concurrently on-device is memory-intensive. `services/ai/modelDownloadManager.ts` reads `expo-device`'s `Device.totalMemory` and treats **7GB** as the tier boundary (`RAM_TIER_THRESHOLD_BYTES`): at or above it, a device is treated as a modern flagship and gets the 3B Llama model; below it, the 1B model. This project's own low-end test device (a Galaxy A50) is 4GB and is the reference point for the "must still work" floor.

**Worth being precise about scope here:** that RAM-tier split is implemented in app code and confirmed in the repo. A Google Play Console device-catalog exclusion rule (blocking install entirely below some RAM floor) is a Play Console **dashboard** setting, external to this codebase — nothing in `app.json`/`eas.json` currently encodes one, so if that exclusion is desired as a second line of defense against OOM terminations on very low-RAM devices, it needs to be configured directly in the Play Console's device catalog, not assumed from anything checked into this repo.

## Handsfree Mode

The `🎧 Handsfree` toggle (floating above the drawer) engages `services/audio/activeMode.ts`'s continuous listen-until-silence loop — an RMS-amplitude VAD that auto-detects when an utterance starts and ends, with no manual tap needed per utterance once engaged.

**Worth being precise about scope here, same as the Hardware Requirements caveat above:** there is no "Hey Xayra" acoustic wake-word engine in this app. A real one (e.g. Porcupine) needs a native module, an external vendor AccessKey, and a custom-trained wake-word model file — none of which exist in this repo. What exists instead is a two-part guard against ambient noise being mistaken for speech:
- **Mutual exclusion** — the manual record button and Handsfree share one native audio-capture session (`@fugood/react-native-audio-pcm-stream` supports exactly one at a time); each refuses to start while the other is active, so they can't corrupt or steal each other's session.
- **Strict post-transcription wake-word filtering** (`containsWakeWord()`, `services/audio/activeMode.ts`) — once a Handsfree utterance is transcribed, the text must match `/(xayra|zaira|cyra|zyra|exayra)/i` (the extra spellings are phonetic near-misses the on-device Whisper model has been observed to mishear "Xayra" as) or it's discarded silently before it ever reaches the database (Record mode) or the RAG pipeline (Ask mode) — no note, no query, no card, no TTS — with a toast confirming the rejection. This is a blunt text match, not a semantic classifier or an audio-level detector, and as of Build 25 there's no length-based exception: every Handsfree utterance must mention the wake word, full stop. Manual recordings never go through this filter: a deliberately short manual note is a real note, not noise.

## UI & Layout Physics

- **Keyboard-locked compose bar** — `ComposeBar.tsx`'s `BottomSheetTextInput` lives inside the sheet as its sticky header; on focus, the sheet explicitly snaps to its 50% stage. The actual fix for this not simply working "for free" was `android_keyboardInputMode="adjustResize"` on `HistorySheet.tsx`'s `<BottomSheet>` — `@gorhom/bottom-sheet`'s own `keyboardBehavior="interactive"` otherwise computes and wins with its own keyboard-avoidance position, overriding any explicit `snapToIndex` call.
- **Backdrop tap-to-dismiss** — the root canvas is a `Pressable` that dismisses the keyboard and snaps the sheet back to index 0 on any tap that isn't claimed by a more specific control (the record button, Handsfree/mode pills, or the sheet itself).
- **Auto-tab segment sync** — `RECORD`-classified submissions flip the sheet's history segment to **Recorded notes**; `ASK`-classified submissions flip it to **Searched notes** and snap the sheet to 50%. Tapping the `[ Record | Ask ]` pill directly also flips the segment immediately, before any submission — the pill and the drawer tab can never disagree.
- **Strict idle sheet isolation** — at snap index 0 (20% resting peek), `HistorySheet.tsx` doesn't render the segment control or either history list at all (not just visually clip them) — they only mount once the sheet reaches its (now sole) 50% expanded stage.
- **50% height cap, structural** — the sheet's `snapPoints` are `["20%", "50%"]` only; a third, 90% stage existed through Build 23 and was removed outright, since a user's own drag gesture could reach it regardless of what the app snapped to programmatically, pushing the sticky header and the floating pill cluster into the status bar.
- **Solid navigation bar** — `app.json`'s `android.navigationBarColor: "#1C1C1E"`, backed by a dedicated in-app `View` docked to the safe-area inset as a second line of defense. Android 15+ increasingly ignores app-set nav-bar colors under enforced edge-to-edge, an OS behavior an app-config value can't override.

*(All items above have been verified on a physical device — see `PROJECT_STATE_HANDOFF.md`'s Build 20–28 entries for exactly what was tested and how.)*

## Privacy & Security

- **Zero cloud calls in the core loop.** Transcription, embedding, retrieval, and answer generation never leave the device — no API key, no account, no telemetry endpoint to phone home to.
- **Air-gapped by design, not by configuration.** There is no cloud fallback silently waiting behind a missing API key; the local model services are the only implementation of transcription/embedding/generation wired into the app.
- **Your data never leaves device storage.** Voice recordings, transcripts, embeddings, and the FTS index all live in one encrypted SQLite database on-device.
- **Encrypted at rest.** The database is encrypted via SQLCipher (`op-sqlite`); the encryption key is generated on first launch and stored in the OS-level keystore/keychain (`expo-secure-store`), gated behind a biometric prompt wherever the device has biometrics enrolled.

## Setup

### Prerequisites

- Node.js, an Android emulator or device, and the Android SDK/NDK set up for Expo native builds.
- **JDK 17** for native Gradle builds — point `JAVA_HOME` at a JDK 17 install (see `CLAUDE.md` for a documented environment quirk with newer JDKs).

### Install & native build

```bash
git clone <this-repository-url>
cd silent-confidant
npm install

npx expo prebuild --clean --no-install
npx expo run:android
```

`npm install` triggers a `postinstall` step (`patch-package`) that applies fixes to native dependencies' Gradle scripts — no action needed, it's automatic.

### Model files

None of the model files ship with the app — in normal use, `services/ai/modelDownloadManager.ts` streams them on demand from the Cloudflare Worker CDN the first time a feature needs one, choosing the Llama size automatically by device RAM tier (see [Hardware Requirements](#hardware-requirements--constraints)). For local development without going through that flow, each file can also be pushed manually to the app's document directory:

```bash
# 1. Whisper (speech-to-text) — tiny is preferred for lower latency; base is used as a fallback if present instead
adb push ggml-tiny.en.bin /data/data/com.anonymous.silentconfidant/files/

# 2. bge-small-en-v1.5 (embeddings) — quantized ONNX export + its vocab
adb push bge-small-en-v1.5-quantized.onnx /data/data/com.anonymous.silentconfidant/files/
adb push bge-small-en-v1.5-vocab.txt /data/data/com.anonymous.silentconfidant/files/

# 3. Llama 3.2 Instruct (chat answers) — pick ONE, matching the -UD-Q4_K_XL quantization
adb push Llama-3.2-1B-Instruct-UD-Q4_K_XL.gguf /data/data/com.anonymous.silentconfidant/files/
# — or, on a 7GB+ RAM device —
adb push Llama-3.2-3B-Instruct-UD-Q4_K_XL.gguf /data/data/com.anonymous.silentconfidant/files/
```

Each local-model service throws a clear error naming exactly which file is missing if you try to use a feature before its model is present.

### Verify

```bash
npx tsc --noEmit                       # type safety
npx expo export --platform android     # bundle safety
```

These two checks validate TypeScript and JS bundling only — they don't prove native code still links. After touching any native dependency, a real native build (`expo prebuild --clean --no-install && expo run:android`) is required; see `CLAUDE.md`.

Then record a voice note or type a note, wait for it to reach "embedded" status, and ask about it — the answer should stream in, cite `[Note N]`, and be read aloud, all without the device touching a network.

## Further reading

`PROJECT_STATE_HANDOFF.md` is this project's running build log — a detailed, reverse-chronological technical record of every build's changes, what was verified, and what's still outstanding. It's the source of truth for anything more granular than this document covers.

## License

MIT — see [LICENSE](LICENSE).
