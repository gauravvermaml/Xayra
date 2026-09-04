# Xayra

**A private, local-first memory recall assistant.**

Record a voice note or type one. It's transcribed, embedded, and indexed — entirely on your phone. Ask a question and get a spoken, cited answer grounded in your own notes — entirely on your phone. No cloud API, no account, no network call, ever, in the core loop.

*(Formerly built and shipped internally as "Silent Confidant," then "Remi," before the full rebrand to Xayra.)*

---

## Product Overview & Aesthetic

As of Build 19, Xayra is a single unified canvas — there is no separate Notes/Chat tab pair anymore. Everything happens on one Apple-Maps-inspired screen:

- **True jet-black (`#000000`) canvas.** Not the app's older charcoal (`#0E0F12`) design system — the recording surface itself is pure black so a [`@gorhom/bottom-sheet`](https://github.com/gorhom/react-native-bottom-sheet) sitting over it (also `#000000`) reads as one continuous surface, the same visual trick Apple Maps uses for its search sheet over the map.
- **A 1.3× central tactile record button** (`components/CentralRecorderCanvas.tsx`) — a white circular control that scales further (up to +6%) in real time while recording, driven by live microphone RMS amplitude, not a canned animation.
- **A stateful RMS waveform** — a row of bars around the button whose heights are driven by the same real amplitude reading (`services/audio/recorder.ts`'s `amplitude`, computed in `services/audio/wav.ts`'s `computeRms`), smoothed with a Reanimated shared-value sine wave rather than jumping frame-to-frame. Idle and recording are visually distinct states, not just a hidden/shown toggle.
- **One sticky bottom sheet, three snap points** (`20% / 50% / 90%`, `components/HistorySheet.tsx`) — a resting "peek" showing just a drag handle and the floating compose bar above it, a mid stage the app snaps to automatically while an answer streams in, and a full expansion for browsing Notes or Q&A history via a segmented control.
- **One text-entry surface** (`components/ComposeBar.tsx`), floating outside the sheet as its own sibling, used identically whether you're typing or the transcript came from voice.

There is no manual Record/Ask mode switch. Every submission — typed or spoken — is classified automatically and routed to the right place (see [Unified Intent Engine](#unified-intent-engine--stage-1--stage-2) below).

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
  │  Unified Intent Engine (2-stage)    │
  │  Stage 1: regex anchor match        │   services/ai/intentRouter.ts
  │  Stage 2: Llama zero-temp fallback  │   services/ai/localLlama.ts
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

### Unified Intent Engine — Stage 1 / Stage 2
`services/ai/intentRouter.ts` classifies every submission (typed or transcribed) as `RECORD` (save as a new note) or `ASK` (treat as a RAG question), shared by both the compose bar and the voice pipeline so the same sentence always routes the same way regardless of how it was entered:
- **Stage 1** — a regex match against question anchors (`what`, `where`, `when`, `who`, `how`, `remind me`, `did i`, `search`, `find`, `how much`) resolves the common case instantly, with no model call at all.
- **Stage 2** — only for text Stage 1 can't confidently place (an ambiguous statement with no question anchor, e.g. "milk is in the fridge" vs. "is there milk in the fridge"), `classifyIntentWithLlama()` runs a deterministic (`temperature: 0`), short (`n_predict: 16`) micro-prompt through the already-loaded Llama context. This is a short, low-token generation by design so it stays fast relative to a full answer — no on-device latency benchmark has actually been recorded for it, so no specific number is claimed here. If Stage 2 itself fails (model not loaded, a native error), the router falls back to `ASK` rather than `RECORD`: silently mis-filing an ambiguous utterance as a permanent note is worse than answering "I don't have anything on that yet."

### Vector RAG Storage
[`@op-engineering/op-sqlite`](https://github.com/OP-Engineering/op-sqlite) (`op-sqlite.sqliteVec: true` / `op-sqlite.fts5: true` in `package.json`) provides an encrypted (SQLCipher) SQLite database with [`sqlite-vec`](https://github.com/asg017/sqlite-vec) compiled in as a `vec0` virtual table alongside an FTS5 virtual table (`db/schema.ts`). `services/notes/noteManager.ts` fuses vector cosine similarity and FTS5 bm25 keyword results via reciprocal rank fusion for hybrid retrieval — the top-K notes are injected into the Llama prompt as an XML `<context>` block, with `[Note N]` citations enforced by the system prompt.

## High-Performance Infrastructure

### Model Streaming
None of the model files (whisper GGML, ONNX embedding model, Llama GGUF — tens of MB to ~2GB) are bundled into the app or downloaded automatically at every launch. When a feature is first used, `services/ai/modelDownloadManager.ts` streams the required file directly to disk using `expo-file-system`'s native `createDownloadResumable()` — a true OS-level background download, not a hand-rolled `fetch()` + JS-heap buffer loop, so multi-hundred-MB files never risk an out-of-memory crash from holding the whole download in JS memory at once. Downloads are pausable/resumable, survive an airplane-mode drop with automatic reconnect, and are backed by an explicit keep-awake lock (`expo-keep-awake`) so the screen sleeping mid-download doesn't stall it.

Files are fetched from a **Cloudflare Worker CDN proxy** (`services/ai/modelCdn.ts`'s `MODEL_CDN_BASE_URL`) rather than hitting Hugging Face or an R2 bucket directly from the client.

## Hardware Requirements & Constraints

Running Whisper transcription and a multi-hundred-MB-to-multi-GB Llama context concurrently on-device is memory-intensive. `services/ai/modelDownloadManager.ts` reads `expo-device`'s `Device.totalMemory` and treats **7GB** as the tier boundary (`RAM_TIER_THRESHOLD_BYTES`): at or above it, a device is treated as a modern flagship and gets the 3B Llama model; below it, the 1B model. This project's own low-end test device (a Galaxy A50) is 4GB and is the reference point for the "must still work" floor.

**Worth being precise about scope here:** that RAM-tier split is implemented in app code and confirmed in the repo. A Google Play Console device-catalog exclusion rule (blocking install entirely below some RAM floor) is a Play Console **dashboard** setting, external to this codebase — nothing in `app.json`/`eas.json` currently encodes one, so if that exclusion is desired as a second line of defense against OOM terminations on very low-RAM devices, it needs to be configured directly in the Play Console's device catalog, not assumed from anything checked into this repo.

## Build 19 — UI & Layout Physics

- **Keyboard pinning** — `ComposeBar.tsx` uses Reanimated's `useAnimatedKeyboard()` (a worklet-backed hook) to read live keyboard height and rides the compose bar up in lockstep via `useAnimatedStyle`, on top of `app.json`'s `android.softwareKeyboardLayoutMode: "resize"`.
- **Backdrop tap-to-dismiss** — the root canvas is a `Pressable` that dismisses the keyboard and snaps the sheet back to index 0 on any tap that isn't claimed by a more specific control (the record button, Handsfree toggle, or the sheet itself).
- **Auto-tab segment flipping** — `RECORD`-classified submissions flip the sheet's history segment to **Notes**; `ASK`-classified submissions flip it to **QA History** and snap the sheet to 50%, so a submission always lands on the tab that actually shows its result, regardless of whether it came from typing, a manual voice recording, or Handsfree.
- **Strict idle sheet isolation** — at snap index 0 (20% resting peek), `HistorySheet.tsx` doesn't render the segment control or either history list at all (not just visually clip them) — they only mount once the sheet reaches 50% or 90%.
- **Solid navigation bar** — `app.json`'s `android.navigationBarColor: "#1C1C1E"`. Note: Android 15+ increasingly ignores app-set nav-bar colors under enforced edge-to-edge, an OS behavior an app-config value can't override — only checkable on a real device running a real OS version.

*(All five items above landed in Build 19 and, as of this writing, have only been verified via `tsc --noEmit` and `expo export` — see `PROJECT_STATE_HANDOFF.md` for the full build log and exactly what's still unverified on a physical device.)*

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
