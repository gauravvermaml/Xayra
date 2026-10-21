# Xayra

**A private, local-first memory assistant for Android.**

Record a voice note or type one. Xayra transcribes it, indexes it and keeps
it in an encrypted database on your phone. Later, ask a question — by voice
or text — and get a short answer, checked against your own notes and read
aloud, with links to the notes it came from.

Speech-to-text, search and answers all run on the phone. After a one-time
model download, the core loop needs no network and no account. Google Drive
backup and Google Calendar reminders are optional and only happen when you
turn them on.

Status: **2.0.0 (versionCode 52), in Google Play internal testing.** Xayra
isn't publicly released.

---

## What it does

- **Record** — tap the emblem and speak; recording ends by itself after a
  short silence. Or type. The text note is what's kept; the audio is
  deleted after transcription.
- **Ask** — ask about anything you've recorded ("When did I last service
  the car?"). Dates like "last week" are resolved before the model runs,
  and every answer is validated against the notes the model was shown. An
  answer that can't be verified is never shown as fact.
- **To-dos and reminders** — "remind me to…" notes become to-dos with local
  reminders. Optionally send one to Google Calendar.
- **Handsfree** — a listen-until-silence mode for when your hands are busy.
- **Launcher shortcuts** — "Record with Xayra" and "Ask Xayra".
- **Encrypted backup** — optional Google Drive backup, encrypted before
  upload, with an optional Extra Privacy mode locked by a recovery code only
  you hold.

## How it works

```
 voice ──► Whisper (whisper.rn) ──► text ──┬─ Record ─► embed (bge-small, ONNX) ─► encrypted vault
 typing ───────────────────────────────────┘                                      (SQLCipher + sqlite-vec + FTS5)
                                           └─ Ask ──► hybrid search ─► dated note context
                                                       ─► Qwen2.5-1.5B fine-tune (llama.rn)
                                                       ─► answer validation ─► text + speech
```

| Layer | Technology |
|---|---|
| App | React Native, Expo SDK 57, TypeScript (strict), Expo Router |
| Speech-to-text | whisper.cpp via `whisper.rn` (`ggml-base.en.bin`) |
| Embeddings | `bge-small-en-v1.5` quantized ONNX via `onnxruntime-react-native` |
| Language model | Fine-tuned Qwen2.5-1.5B-Instruct, GGUF Q4_K_M, via `llama.rn` |
| Storage | `op-sqlite` with SQLCipher 4, `sqlite-vec` and FTS5 |
| Keys | Android Keystore via `expo-secure-store`, biometric-gated where enrolled |
| Speech output | Android TextToSpeech via `expo-speech` |

Details: [ARCHITECTURE.md](ARCHITECTURE.md).

## Privacy and security

- Notes, to-dos and the search index are stored in an SQLCipher-encrypted
  database. The 256-bit key is held by Android Keystore.
- Your notes, recordings and questions are never sent to an AI service or
  to any server the developer runs.
- No analytics, no advertising SDKs, no crash reporting.
- Android's own cloud backup and device transfer are turned off for Xayra;
  use Xayra's encrypted Drive backup instead.
- Upcoming reminder text is held by Android's notification system so it
  can alert you on time.

Privacy policy: <https://gist.github.com/gauravvermaml/9cdeb107d9a85a24370e307237450aa3>.
Security reports: see [SECURITY.md](SECURITY.md).

## Getting started (development)

Requirements: Node.js 24, the Android SDK and NDK, JDK 17, and an Android
device or emulator.

```bash
npm ci                                   # also applies patches/ (patch-package)
npx tsc --noEmit
npx jest
```

Xayra uses native modules, so it runs in a development build, not Expo Go.
The **Xayra Dev** variant installs alongside the Play build without
touching it:

```bash
APP_VARIANT=development CI=1 npx expo prebuild --clean --no-install --platform android
cd android && APP_VARIANT=development ./gradlew assembleDebug
```

The app downloads its models on first launch. Full setup, variants, model
side-loading and troubleshooting: [DEVELOPMENT.md](DEVELOPMENT.md).

## Project documents

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Pipeline, vault, backup, answer validation, invariants |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Setup, build variants, models, tests, troubleshooting |
| [RELEASE.md](RELEASE.md) | The release gate and how a production build is made |
| [CHANGELOG.md](CHANGELOG.md) | Changes by version |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution policy |
| [BACKLOG.md](BACKLOG.md) | Open issues, known limitations and unapproved ideas |
| [PROJECT_STATE_HANDOFF.md](PROJECT_STATE_HANDOFF.md) | Historical build log (through 1.0.42) |
| [CLAUDE.md](CLAUDE.md) | Engineering rules for AI-assisted development |

## Licence

Xayra is proprietary software. Copyright © 2026 Gaurav Verma. All rights reserved.

This repository is public so the source can be read. It is not open source:
no licence is granted to copy, modify, redistribute or commercially use
Xayra's code, apart from viewing and forking on GitHub as GitHub's Terms of
Service allow. See [LICENSE](LICENSE).

Third-party components (the Expo project template, fonts, patched npm
packages and the AI models the app downloads) keep their own licences; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
