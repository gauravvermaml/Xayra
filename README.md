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
- **One sticky bottom sheet, capped at two snap points** (`20% / 50%`, `components/HistorySheet.tsx`) — a resting "peek" showing just a drag handle and the sticky compose bar, and a single expanded stage showing one list: Q&A history ("Recent Answers"). There used to be a third, 90% stage; it was removed outright — a user's own drag gesture could reach it regardless of what the app snapped to programmatically, which pushed content into the status bar. The landing screen's "browse every past recording" card ("Recorded notes") is gone too, as of the "Quiet Corner" pass — the app's whole premise is "record, then just ask later," so a scrollable archive sitting on the landing screen worked against that. It's one tap away instead, via `app/archive.tsx` (see [UI & Layout Physics](#ui--layout-physics)).
- **One text-entry surface** (`components/ComposeBar.tsx`), living inside the sheet as its sticky header, used identically whether you're typing or the transcript came from voice. Submitting (the arrow tap or the keyboard's own send key) dismisses the keyboard immediately, for both Record and Ask.
- **An explicit `[ Record | Ask ]` mode pill**, floating with a `🎧 Handsfree` toggle and a `To-Dos` pill above the drawer — see [Explicit Mode Routing](#explicit-mode-routing) below. Archive and Settings, both deliberately low-frequency destinations, share one small "•••" icon inline with the To-Dos pill instead of each getting a permanent pill of their own.

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
`services/ai/localLlama.ts` runs a quantized Llama 3.2 Instruct GGUF model via [`llama.rn`](https://github.com/mybigday/llama.rn) (llama.cpp). Two sizes are supported — a 1B and a 3B variant, both `-UD-Q4_K_XL.gguf` (Unsloth Dynamic quantization). Every device downloads the 1B model unconditionally on first run; a device only ever moves to the 3B model via a real, measured opportunistic upgrade — see [Hardware Requirements](#hardware-requirements--constraints) for why RAM alone was dropped as the selection signal, and `services/ai/modelPerformanceTracker.ts` / `maybeAttemptTierUpgrade()` in `services/ai/modelDownloadManager.ts` for how the upgrade is decided and trialed. If a 3B file is already on disk (an already-upgraded device, or one manually pushed via `adb`), it's preferred over the 1B.

### Explicit Mode Routing
Earlier builds (through Build 21) classified every submission automatically via a two-stage regex + Llama micro-prompt router (`services/ai/intentRouter.ts`). As of Build 22, that file — and its Llama-side half, `classifyIntentWithLlama()` in `services/ai/localLlama.ts` — is **deleted**, not just unused. Routing is now 100% deterministic: an explicit `[ Record | Ask ]` pill (floating above the drawer, synced with which drawer segment is showing) is the single source of truth for what a submission does, set only by the user's own tap. `RECORD` always saves a note (SQLite + vector index, zero RAG calls); `ASK` always runs retrieval + generation (zero note writes) — never both, never a guess. This is a deliberate product reversal, not a bug fix: automatic classification traded away the occasional wrong guess on ambiguous input (e.g. "do laundry" vs. "did I do laundry") for convenience; the explicit pill trades that convenience back for the user always knowing exactly what a submission will do before they make it.

### Vector RAG Storage
[`@op-engineering/op-sqlite`](https://github.com/OP-Engineering/op-sqlite) (`op-sqlite.sqliteVec: true` / `op-sqlite.fts5: true` in `package.json`) provides an encrypted (SQLCipher) SQLite database with [`sqlite-vec`](https://github.com/asg017/sqlite-vec) compiled in as a `vec0` virtual table alongside an FTS5 virtual table (`db/schema.ts`). `services/notes/noteManager.ts` fuses vector cosine similarity and FTS5 bm25 keyword results via reciprocal rank fusion for hybrid retrieval — the top-K notes are injected into the Llama prompt as an XML `<context>` block, with `[Note N]` citations enforced by the system prompt.

## High-Performance Infrastructure

### Model Streaming
None of the model files (whisper GGML, ONNX embedding model, Llama GGUF — tens of MB to ~2GB) are bundled into the app or downloaded automatically at every launch. The app gates entirely behind a full-screen "One Door, Opens Once" onboarding screen (`components/OnboardingSetupScreen.tsx`) until all three are on disk — see `PROJECT_STATE_HANDOFF.md`'s Build 32 entry for why a partial/locked app state was worse than a single clear setup step.

Whisper and the Llama chat model — the two large, slow phases — are handed to **Android's own system `DownloadManager` service** via a local native module, `modules/download-bridge/` (not a hand-rolled `fetch()` + JS-heap buffer loop, and not even `expo-file-system`'s `DownloadResumable`): a real OS-level transfer that survives this app's process being frozen, killed, or backgrounded, which the onboarding screen's own "feel free to minimize" copy explicitly invites. The much smaller embedding model still uses `expo-file-system`'s `createDownloadResumable()` directly (`services/ai/embeddingModel.ts`) — not worth the same treatment for a file that finishes in seconds. `expo-keep-awake` backs the whole flow so the screen sleeping mid-setup doesn't stall it.

Files are fetched from a **Cloudflare Worker CDN proxy** (`services/ai/modelCdn.ts`'s `MODEL_CDN_BASE_URL`) rather than hitting Hugging Face or an R2 bucket directly from the client.

Progress is surfaced two ways at once, both fed by the same `modelDownloadManager.ts` status:
- **In-app** — `components/ModelDownloadCard.tsx`, rendered in natural flex flow in the drawer beneath whichever list is showing ("Downloading in progress... N% of 100%"), with explicit spacing so its text never collides with the Android nav bar.
- **Notification shade** — `services/notifications/downloadNotification.ts` mirrors the same progress there, so it stays visible even while Xayra isn't the foreground app. The channel is `MIN` importance with `sound: null`/`vibrationPattern: []`/`enableVibrate: false` at the channel level and repeated per-notification (`sound: false`, `vibrate: []`, `badge: 0`) — confirmed on-device sitting quietly under the shade's own "Silent" section, no heads-up popup, no vibration, no launcher badge. Updates are throttled to at most one native post per 5-percentage-point step or 3 seconds, whichever comes first, and the channel is passed via the notification's `trigger` (`{ channelId }`) rather than its `content` — the latter has no such field, and an earlier attempt that put it there was silently dropped, landing every notification on Android's noisy default fallback channel instead.

The moment a model finishes downloading (or is found already on disk at boot), `services/ai/localLlama.ts`'s `prewarmLocalLlama()` loads the GGUF context **and** runs one silent, throwaway 1-token completion — llama.cpp's KV-cache/thread-pool spin-up is otherwise lazily deferred to the first real generation call, which is what used to make a user's first "Ask" after setup noticeably slower than every one after it. By the time the user actually asks something, the context is already fully hot. Every call site funnels through one deduplicated in-flight promise (the same pattern the context loader itself uses), so the app-boot warm-up and the "download just finished" warm-up can never race each other into calling the native completion API twice at once.

## Hardware Requirements & Constraints

Running Whisper transcription and a multi-hundred-MB-to-multi-GB Llama context concurrently on-device is memory-intensive — but RAM alone turned out to be a bad proxy for whether a device can actually run the 3B Llama model at a *usable speed*, not just fit it in memory. Confirmed on-device (a Redmi Note 8 Pro — 8 cores, 7.48 GiB RAM, comfortably over any RAM threshold): a first retrieval on the 3B model took **12+ minutes**, because the CPU (a 2019 mid-range chipset, at the time also capped to a fixed quarter of its cores — see the thread-count paragraph right below, since fixed) can't sustain it, regardless of RAM headroom.

**Inference thread count is measured, not guessed from core count** (`computeInferenceThreadCount()`, `services/ai/localLlama.ts`) — a flat "use a quarter of this device's cores" formula, reverse-engineered from one 2019 budget chip that froze at half that many threads, turned out to silently cap a modern flagship (a Pixel 9 tester, 12GB RAM: ~2-minute retrievals on just 48 notes) to the exact same thread count as that old test phone — the identical RAM-alone mistake above, just for CPU threads instead of model size. `attemptOptimisticThreadCalibration()` runs a real, bounded, cancellable trial once during onboarding — before the user's first real question — starting from an OPTIMISTIC thread count (reserve only 2 cores for the OS) rather than earning speed up from the conservative default over time, since this app's real target users are 2023+ flagship-class devices, not the 2019 phones kept around for edge-case testing. A device that can't handle it (bounded by a 12s timeout, actually cancellable via `llama.rn`'s `stopCompletion()`) falls back cleanly to the old conservative default, with a second chance later via `maybeAttemptThreadEscalation()` once it has real usage history. Confirmed on-device: even the Redmi above — this project's own worst-case reference device — went from ~3.1 tok/s at 2 threads to **11.4 tok/s at 6 threads**, roughly a 3.5–4x speedup, on hardware nowhere near this fix's actual target.

Every device now downloads the 1B model unconditionally on first run. `services/ai/modelDownloadManager.ts` still reads `expo-device`'s `Device.totalMemory` and treats **7GB** as a hard prerequisite (`RAM_FLOOR_FOR_3B_BYTES`) for a device to even be *considered* for the 3B model — but RAM alone no longer decides the outcome. `services/ai/modelPerformanceTracker.ts` tracks a rolling window of real, measured completion throughput (llama.cpp's own native `timings.predicted_per_second`, never a synthetic one-shot benchmark — a single measurement taken at the wrong moment, before sustained-load thermal throttling or while other setup work is still competing for CPU, can misjudge a device in either direction); only once a device's real 1B performance comfortably clears a usable floor does `maybeAttemptTierUpgrade()` even attempt the 2GB 3B download, and even then the upgrade is only kept if a real trial completion on the 3B model itself clears that same floor — otherwise it's rolled back to 1B automatically, no user-facing decision either way. This project's own low-end test device (a Galaxy A50, 4GB) remains the reference point for the "must still work at all" floor; the Redmi is the reference point for "fits the old RAM-only tier boundary but shouldn't get the bigger model anyway."

**Worth being precise about scope here:** the tiering logic above is implemented in app code and confirmed in the repo. A Google Play Console device-catalog exclusion rule (blocking install entirely below some RAM/SoC floor) is a Play Console **dashboard** setting, external to this codebase — nothing in `app.json`/`eas.json` currently encodes one. It was evaluated as a *complementary*, not alternative, lever to the in-app tiering above (a backstop for genuinely incompatible hardware, once real crash/ANR telemetry exists to justify one) — not assumed from anything checked into this repo, and not a substitute for measuring real device performance in-app.

## Handsfree Mode

The `🎧 Handsfree` toggle (floating above the drawer) engages `services/audio/activeMode.ts`'s continuous listen-until-silence loop — an RMS-amplitude VAD that auto-detects when an utterance starts and ends, with no manual tap needed per utterance once engaged.

**Worth being precise about scope here, same as the Hardware Requirements caveat above:** there is no "Hey Xayra" acoustic wake-word engine in this app. A real one (e.g. Porcupine) needs a native module, an external vendor AccessKey, and a custom-trained wake-word model file — none of which exist in this repo. What exists instead is a two-part guard against ambient noise being mistaken for speech:
- **Mutual exclusion** — the manual record button and Handsfree share one native audio-capture session (`@fugood/react-native-audio-pcm-stream` supports exactly one at a time); each refuses to start while the other is active, so they can't corrupt or steal each other's session.
- **Strict post-transcription wake-word filtering** (`containsWakeWord()`, `services/audio/activeMode.ts`) — once a Handsfree utterance is transcribed, it must contain something recognizable as the wake word or it's discarded silently before it ever reaches the database (Record mode) or the RAG pipeline (Ask mode) — no note, no query, no card, no TTS — with a toast confirming the rejection. A fixed literal spelling list ("Zaira", "Cyra", "Zyra", "Exayra") turned out not to keep up with "Xayra" being an invented brand name the on-device Whisper model has no training exposure to — confirmed an 8-in-10 miss rate even at clear, close range. The match is now a bounded Levenshtein edit-distance check (`WAKE_WORD_CANONICAL`/`MAX_EDIT_DISTANCE`, distance ≤ 2) against every transcript token, catching a much wider space of misspellings than a literal list while keeping unrelated words (e.g. "Sarah," distance 3) safely outside the gate. This is still a blunt spelling-based heuristic, not a phonetic/semantic model — every Handsfree utterance must mention something close to the wake word, full stop, with no length-based exception. Manual recordings never go through this filter: a deliberately short manual note is a real note, not noise.
- **Whisper is primed with an initial prompt** (`services/ai/localWhisper.ts`) — "Hey Xayra" was found to get erased entirely (transcribed as an unrelated common phrase, not just misspelled) more often than "Xayra" alone. whisper.cpp's `initial_prompt` mechanism, given the literal string `"Xayra"`, biases the decoder toward recognizing that spelling without it needing to be in the model's own training vocabulary — at zero extra inference cost.
- **The native mic session stays open for the whole Handsfree engagement**, not re-opened per utterance — a prior version called `AudioRecord.init()`/`.start()` fresh on every utterance boundary, and the resulting hardware cold-start reproducibly clipped the wake word's own first syllable(s) at any distance. A JS-side `capturing` flag now gates whether incoming audio counts toward the current utterance, with the native stream itself never actually stopped except when Handsfree fully disengages.
- **Recordings are peak-normalized before transcription** (`services/audio/wav.ts`) — raw mic PCM used to be written to the WAV completely unamplified, and a quiet/distant recording's own softest moment (an utterance's first syllable, almost always its quietest) had no headroom left to survive. Every recording is now scaled up toward 90% of full scale (capped at 8× gain, so a near-silent buffer can't be amplified into hiss/static), a no-op if it's already loud enough.

## UI & Layout Physics

- **Keyboard-locked compose bar** — `ComposeBar.tsx`'s `BottomSheetTextInput` lives inside the sheet as its sticky header; on focus, the sheet explicitly snaps to its 50% stage. The actual fix for this not simply working "for free" was `android_keyboardInputMode="adjustResize"` on `HistorySheet.tsx`'s `<BottomSheet>` — `@gorhom/bottom-sheet`'s own `keyboardBehavior="interactive"` otherwise computes and wins with its own keyboard-avoidance position, overriding any explicit `snapToIndex` call. `keyboardBlurBehavior` is `"none"`, not the library's own `"restore"` — every snap on this sheet is already explicit (drag handle, backdrop tap, keyboard focus, post-submit reveal), and `"restore"` would independently re-snap the sheet on the blur that now fires when a submit dismisses the keyboard (see below), undoing that same reveal out from under it.
- **The Recent Answers list hides itself while actually composing**, without touching the sheet's own snap index at all — `isComposing` (app/index.tsx) is true from focus until blur or submit, passed to `HistorySheet` as `contentHidden`. A first attempt tried to get the same result by force-collapsing the sheet to its 20% index on focus instead, which broke the keyboard-avoidance behavior above; decoupling "is the list visible" from "which index is the sheet at" fixed both independently.
- **Submitting dismisses the keyboard**, for Record and Ask alike (`Keyboard.dismiss()` in `ComposeBar.tsx`'s shared submit handler) — `blurOnSubmit={false}` on the input only ever stopped its own automatic blur-on-submit, it was never a statement the keyboard should stay up after a real send.
- **Backdrop tap-to-dismiss** — the root canvas is a `Pressable` that dismisses the keyboard and snaps the sheet back to index 0 on any tap that isn't claimed by a more specific control (the record button, Handsfree/mode pills, or the sheet itself).
- **Strict idle sheet isolation** — at snap index 0 (20% resting peek), `HistorySheet.tsx` doesn't render the glass box or its list at all (not just visually clip them) — it only mounts once the sheet reaches its (now sole) 50% expanded stage.
- **Archive/Settings quick menu, anchored not fixed** — the "•••" icon's popover position is measured from the icon's own real on-screen location (`measureInWindow`, taken at tap time) rather than a fixed screen corner or a duplicated copy of the pill cluster's own Reanimated-driven position math. It's a plain conditionally-mounted sibling `View`, deliberately never a real native `<Modal>` — see the Handsfree/native-window note in `TodosOverlay.tsx`: any extra native window (an IME popup, a native `<Modal>`) losing focus while a *pushed* route (Settings, Archive) comes up on top reproducibly leaves that pushed screen's touch input dead on this app's Android/react-native-screens stack. Confirmed on-device with the native-`<Modal>` version of this menu before the fix: Settings' own Back button went dead the instant it was reached from here.
- **50% height cap, structural** — the sheet's `snapPoints` are `["20%", "50%"]` only; a third, 90% stage existed through Build 23 and was removed outright, since a user's own drag gesture could reach it regardless of what the app snapped to programmatically, pushing the sticky header and the floating pill cluster into the status bar. Build 29's full-screen "expanded notes" view (below) reads as a third stage but deliberately isn't one — see its own entry for why.
- **Solid navigation bar** — `app.json`'s `android.navigationBarColor: "#1C1C1E"`, backed by a dedicated in-app `View` docked to the safe-area inset as a second line of defense. Android 15+ increasingly ignores app-set nav-bar colors under enforced edge-to-edge, an OS behavior an app-config value can't override.
- **Monochromatic Glass expandable notes container** (`components/ExpandedTextOverlay.tsx`) — a translucent glass box wraps the active note/Q&A list both at the sheet's normal 50% stage and, via its top-right micro-chip, in a full-screen "focus mode." That full-screen stage is deliberately **not** a third stage of the bottom sheet: `@gorhom/bottom-sheet` caps its own content-area height at the highest *configured* `snapPoints` entry regardless of where an out-of-range `snapToPosition` visually moves the frame, so a real attempt at this via the sheet itself only ever filled about half the screen. The full-screen view is instead a plain, separate `position: absolute` overlay rendered alongside `<HistorySheet>`, with no such ceiling — see `PROJECT_STATE_HANDOFF.md`'s Build 29 entry for the full chain of on-device bugs (chip/text overlap, a gesture reaching a stage it shouldn't, the half-screen fill, and a `BottomSheetFlatList`-outside-a-`BottomSheet` crash) this went through to get there.

*(All items above have been verified on a physical device — see `PROJECT_STATE_HANDOFF.md`'s Build 20–29 entries for exactly what was tested and how.)*

## Privacy & Security

- **Zero cloud calls in the core loop.** Transcription, embedding, retrieval, and answer generation never leave the device — no API key, no account, no telemetry endpoint to phone home to.
- **Air-gapped by design, not by configuration.** There is no cloud fallback silently waiting behind a missing API key; the local model services are the only implementation of transcription/embedding/generation wired into the app.
- **Your data never leaves device storage.** Transcripts, embeddings, and the FTS index all live in one encrypted SQLite database on-device. The raw audio recording itself is deleted immediately after transcription — every note is transcript-only, `audio_uri = NULL`, with nothing kept to leave the device in the first place. (A note recorded before this change, or one restored from a Drive backup, may still carry a real audio file on that one device; every note recorded since does not.)
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

None of the model files ship with the app — in normal use, the onboarding flow (`components/OnboardingSetupScreen.tsx` + `services/ai/modelDownloadManager.ts`) streams them on demand from the Cloudflare Worker CDN, always starting with the 1B Llama model (see [Hardware Requirements](#hardware-requirements--constraints) for why RAM alone no longer picks the 3B model outright). For local development without going through that flow, each file can also be pushed manually to the app's document directory — this bypasses the onboarding gate/DownloadManager plumbing entirely and lands the files exactly where `FileSystem.documentDirectory` expects them.

**On a rooted device/emulator**, a plain `adb push` straight to the app's private storage works:

```bash
adb push <file> /data/data/com.anonymous.silentconfidant/files/
```

**On a non-rooted device** (confirmed live, 2026-09-16, on a Redmi Note 8 Pro) that fails with `remote secure_mkdirs failed` or `Permission denied` — `/data/data/<package>/` isn't writable by a plain `adb push` without root. Use the standard two-step workaround instead: push to the world-writable `/data/local/tmp/`, then copy into the app's own storage as the app's own user via `run-as` (only works on a debuggable build):

```bash
adb push <file> /data/local/tmp/<file>
adb shell run-as com.anonymous.silentconfidant cp /data/local/tmp/<file> files/<file>
adb shell rm /data/local/tmp/<file>   # optional cleanup — the temp copy still counts against device storage until removed
```

(On Windows/Git Bash specifically, prefix both `adb push`/`adb shell` calls with `MSYS_NO_PATHCONV=1` — otherwise MSYS mangles the `/data/...` remote path into a Windows path before adb ever sees it.)

Files to push:

```bash
# 1. Whisper (speech-to-text) — tiny is preferred for lower latency; base is used as a fallback if present instead
ggml-tiny.en.bin

# 2. bge-small-en-v1.5 (embeddings) — quantized ONNX export + its vocab
bge-small-en-v1.5-quantized.onnx
bge-small-en-v1.5-vocab.txt

# 3. A local LLM (chat answers) — pick ONE.
# Pushing the 3B Llama file directly here skips the in-app measured-
# performance trial entirely — fine for local dev, but means the device
# never actually proved it can run 3B at a usable speed the way a real
# opportunistic upgrade would have required.
Llama-3.2-1B-Instruct-UD-Q4_K_XL.gguf
# — or —
Llama-3.2-3B-Instruct-UD-Q4_K_XL.gguf
# — or, since Build 46, an on-trial alternative (manual-push-only, not
# part of the automatic download tier logic — see PROJECT_STATE_HANDOFF.md's
# Build 46 section) —
Qwen2.5-3B-Instruct-Q4_K_M.gguf
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
