# Architecture

How Xayra is put together. For the engineering rules that keep these
pieces correct, see [CLAUDE.md](CLAUDE.md); this document explains the
design.

## Principles

- **Local-first core loop.** Transcription, embedding, search and answer
  generation run on the phone. None of them needs a network call or an API
  key. Network features (model download, Drive backup, Calendar) are
  optional and kept apart from the core loop.
- **The text note is the durable artefact.** Audio is temporary.
- **Validate, never rewrite.** Generated answers are checked against the
  notes; an answer that fails is withheld, never edited into something else.
- **Fail closed.** Missing keys, unreadable state or an unverified backup
  stop the operation rather than guessing.

## Layout

| Path | Responsibility |
|---|---|
| `app/` | Expo Router screens (home, settings, archive; dev-only screens are gated) |
| `components/` | UI, including the Halo/Orbit home, tray and compose bar |
| `services/ai/` | Whisper, embeddings, tokenizer, llama.cpp queue, RAG, date resolution, answer validation, to-do extraction, model downloads |
| `services/audio/` | Mic session, recorder, silence detection, playback, text-to-speech |
| `services/notes/`, `services/search/` | Note storage and hybrid search |
| `services/vault/`, `services/crypto/` | Encrypted database lifecycle and keys |
| `services/backup/`, `services/sync/`, `services/recovery/` | Encrypted Google Drive backup, Google sign-in, recovery |
| `services/todos/`, `services/notifications/`, `services/calendar/` | To-dos, local reminders, Calendar push |
| `db/` | Schema (Drizzle plus raw `vec0`/FTS5 SQL) and connection |
| `modules/` | Small local Expo native modules (signature check, CPU/thermal info, Android DownloadManager bridge) |
| `plugins/` | Expo config plugins (launcher shortcuts, no system backup, private test signing) |
| `patches/` | `patch-package` fixes for native dependencies |

## Capture

1. One microphone owner (`services/audio/micSession.ts`) — recording,
   Handsfree and voice Ask never overlap.
2. Recording ends after trailing silence (Ask 1.5 s, Record 2.2 s) using the
   same silence detector as Handsfree. The Record/Ask mode is frozen per
   utterance.
3. The WAV lives in the app cache only until transcription, then is
   deleted. Leftovers are cleaned on launch.
4. Whisper (`whisper.rn`) transcribes on a shared native context; decodes
   are queued.
5. **Record** writes the note (the point of no return) and embeds it with
   bge-small (384 dimensions). **Ask** runs retrieval and generation and
   writes nothing.

Each capture or Ask is a processing job (`services/ai/processingJob.ts`).
Cancel is acknowledged immediately; every later step checks that its job
still owns the screen before saving, showing or speaking.

## Search and answers

1. **Hybrid retrieval** — vector similarity (`sqlite-vec`) and keyword
   search (FTS5) fused with reciprocal rank fusion
   (`services/notes/noteManager.ts`).
2. **Dates first** — `temporalResolver.ts` resolves time phrases in the
   question and in each note (relative to when it was recorded) before
   generation, ranks notes for the asked period and writes dates inline.
3. **Generation** — the fine-tuned Qwen2.5-1.5B model via `llama.rn`, at
   temperature 0. A shared priority queue lets an Ask run ahead of
   background to-do extraction; the static prompt prefix's state is cached
   on disk so a cold start doesn't re-pay the prefill.
4. **Validation** — `finalizeAnswer` (`ragFormatting.ts`) runs refusal
   mapping, unsupported-denial and "Yes" checks, an explicit-year check,
   relationship grounding (each statement must be supported by one sentence
   the model was shown, with note and sentence provenance) and word-overlap
   grounding. A failure becomes "couldn't verify an accurate answer", with
   the related notes listed but not presented as proof.
5. Raw tokens are never shown or spoken. Progress stages ("Looking through
   your memories…", "Found N related memories…") come from real pipeline
   events. With zero matching notes the model doesn't run.

RAG Grounding v1 is frozen as the release baseline; changes need a
release-blocking failure (see CLAUDE.md).

## The vault

- SQLCipher 4 database at `files/vault/xayra.sqlite`, opened with a raw
  256-bit key (`x'<hex>'`). The key is stored by `expo-secure-store` in
  Android Keystore, biometric-gated where enrolled.
- `vaultState.ts` is a pure state machine — facts on disk decide open,
  migrate, create or fail closed. `vaultActivation.ts` performs it. The
  commit point is `files/vault-pointer.json` (written by temp file and
  rename); no user write reaches a vault before its pointer is committed.
- Upgrades from the old unencrypted database copy it, verify it, export it
  into SQLCipher and check row for row. The old file is only read, and is
  removed only when the user approves.

## Backup (optional)

- **Standard Protection** — each backup generation is an SQLCipher file in
  the Google Drive hidden app folder, encrypted with an account backup key
  that is also kept in that folder (the app says so). A generation becomes
  restorable only after an independent download, decrypt, integrity and
  record check. Files are only ever created, never overwritten; merges are
  insert-only and newer-edit-wins.
- **Extra Privacy** — backups are locked with a key that exists only under
  a recovery code the user keeps, on their phones behind the fingerprint,
  and in a local escrow. Google access alone can't restore them.
- Each phone uploads its own vault key, encrypted with the backup key, so
  "Recover my notes" works after a fingerprint change.
- Android's own Auto Backup and device transfer are disabled
  (`plugins/withNoSystemBackup.js`), because they would copy unencrypted
  app state such as reminder text.

## Reminders

Local notifications via `expo-notifications`, one handler app-wide.
Reminders are re-armed once per process after the vault opens, so a
force-stop doesn't lose them.

## Models

Models are downloaded on first launch, not bundled. The large files go
through Android's DownloadManager (`modules/download-bridge`) so the
transfer survives the app being backgrounded. Whisper and the language
model come from Xayra's model server; the embedding model comes from
Hugging Face. Licences: [licenses/MODEL_NOTICE.md](licenses/MODEL_NOTICE.md).

## Logging

No log may contain note, transcript, question or to-do text in any build;
logs carry lengths, counts and flags (`services/logging/redact.ts`, enforced
by `__tests__/privacyLogging.test.ts`). The RAG pipeline trace, which does
print note text, is development-only.
