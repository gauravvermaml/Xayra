# Xayra

**A private, local-first memory recall assistant.**

Record a voice note. It's transcribed, embedded, and indexed — entirely on your phone. Ask a question in chat and get a spoken, cited answer grounded in your own notes — entirely on your phone. No cloud API, no account, no network call, ever, in the core loop.

*(Formerly built and shipped internally as "Silent Confidant," then "Remi," before the full rebrand to Xayra.)*

---

## Features

- 🎙️ **Local speech-to-text** — [`whisper.rn`](https://github.com/mybigday/whisper.rn) (whisper.cpp) transcribes voice notes and spoken chat queries on-device.
- 🔎 **384-dim local vector search** — a quantized [`bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) embedding model runs via [`onnxruntime-react-native`](https://github.com/microsoft/onnxruntime), indexed with [`sqlite-vec`](https://github.com/asg017/sqlite-vec) and fused with SQLite FTS5 keyword search (reciprocal rank fusion) for hybrid retrieval.
- 🧠 **On-device Llama 3.2 inference** — a quantized **Llama 3.2 1B Instruct** GGUF model runs via [`llama.rn`](https://github.com/mybigday/llama.rn) (llama.cpp), streaming a cited, grounded RAG answer token-by-token (a 3B variant is supported and preferred automatically if pushed to a device with the headroom for it).
- 🔊 **Native text-to-speech** — Android's built-in TTS engine reads answers aloud, hands-free.
- 🔐 **Encrypted at rest** — the SQLite database is encrypted (SQLCipher via `op-sqlite`), with the encryption key held in the OS keystore/keychain and gated behind biometrics wherever they're enrolled.
- ☁️ **Hidden Google Drive backup, opt-in** — an optional encrypted backup to the `drive.appdata` scope only: a hidden, per-app Drive folder invisible in your normal Drive UI and unreadable by any other app or client. Off by default; the core loop never depends on it.
- 🎨 **Custom OLED dark UI** — a hand-built charcoal/near-black (`#0E0F12`) design system with a single violet accent and a dual violet/cyan glow on the recording indicator, tuned for true-black/OLED displays.

## Architecture

```
  🎙️  Voice Recording (expo-audio)
         │
         ▼
  ┌─────────────────────────┐
  │   Local Whisper STT     │   whisper.rn (whisper.cpp)
  │   ggml-*.bin  (GGML)    │   — fully on-device transcription
  └─────────────────────────┘
         │  transcript text
         ▼
  ┌─────────────────────────┐
  │  Local ONNX Embedding   │   onnxruntime-react-native
  │  bge-small-en-v1.5      │   — BERT WordPiece tokenizer (from scratch)
  │  384-dim vector         │   — mean-pooled, L2-normalized
  └─────────────────────────┘
         │  384-d vector
         ▼
  ┌─────────────────────────┐
  │  SQLite Vector Storage  │   sqlite-vec (vec0 virtual table)
  │  + FTS5 keyword index   │   — encrypted at rest (SQLCipher)
  └─────────────────────────┘
         │
         │            ┌────────────────────────────┐
         └───────────▶│  Hybrid Retrieval (RRF)     │◀── user query
                       │  vector cosine + FTS5 bm25  │    (typed or spoken,
                       └────────────────────────────┘     transcribed by
                              │  top-K notes                the same local
                              ▼                              Whisper above)
                    ┌───────────────────────────┐
                    │  <context><note>…</note>  │
                    │  </context>  (XML block)  │
                    └───────────────────────────┘
                              │
                              ▼
                    ┌───────────────────────────┐
                    │   Local Llama 3.2 1B LLM   │   llama.rn (llama.cpp)
                    │   Instruct-template prompt │   — streamed token-by-token
                    │   GGUF, Q4_K_M quantized   │   — [Note N] citations
                    └───────────────────────────┘
                              │  streamed answer text
                              ▼
                    ┌───────────────────────────┐
                    │   Native TTS (expo-speech)  │  — hands-free playback
                    └───────────────────────────┘
```

Every box above runs **on the device**. Nothing in this pipeline makes a network request.

## Privacy & Security

- **Zero cloud calls in the core loop.** Transcription, embedding, retrieval, and answer generation never leave the device — no API key, no account, no telemetry endpoint to phone home to.
- **Air-gapped by design, not by configuration.** There is no cloud fallback silently waiting behind a missing API key; the local model services are the only implementation of transcription/embedding/generation wired into the app. (Legacy OpenAI-backed code exists in the repo for reference but is fully unreferenced — see `CLAUDE.md`.)
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

`npm install` triggers a `postinstall` step (`patch-package`) that applies two required fixes to native dependencies' Gradle scripts — no action needed, it's automatic.

### Download & push the local models

None of the model files ship with the app (they're tens to hundreds of MB) — download each once and push it to the app's document directory on your emulator/device:

```bash
# 1. Whisper (speech-to-text) — tiny is preferred for lower latency; base is used as a fallback if present instead
adb push ggml-tiny.en.bin /data/data/com.anonymous.silentconfidant/files/

# 2. bge-small-en-v1.5 (embeddings) — quantized ONNX export + its vocab
adb push bge-small-en-v1.5-quantized.onnx /data/data/com.anonymous.silentconfidant/files/
adb push bge-small-en-v1.5-vocab.txt /data/data/com.anonymous.silentconfidant/files/

# 3. Llama 3.2 1B Instruct (chat answers) — Q4_K_M quantized GGUF
adb push Llama-3.2-1B-Instruct-Q4_K_M.gguf /data/data/com.anonymous.silentconfidant/files/
```

All four files should be sourced from their respective official repositories (whisper.cpp's GGML model releases, BAAI's `bge-small-en-v1.5` converted to ONNX, and Meta's Llama 3.2 1B Instruct converted to GGUF). Each local-model service throws a clear error naming exactly which file is missing if you try to use a feature before pushing its model.

### Verify

```bash
npx tsc --noEmit                       # type safety
npx expo export --platform android     # bundle safety
```

Then record a voice note, wait for it to reach "embedded" status, and ask about it in Chat — the answer should stream in, cite `[Note N]`, and be read aloud, all without the device touching a network.

## License

MIT — see [LICENSE](LICENSE).
