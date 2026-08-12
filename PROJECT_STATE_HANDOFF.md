# Silent Confidant — Project State Handoff

Last updated: end of Phase 3D Stage 1 (commit `2d6389a`).

## Completed State

**Phase 3C — Rich Note Detail & Audio Playback Subsystem**
- `services/audio/player.ts`: single-instance audio player singleton built on `expo-audio`'s `createAudioPlayer`. Exactly one native `AudioPlayer` exists app-wide; starting a new track always pauses/replaces whatever was previously playing. Exposes state via `useSyncExternalStore` through `useAudioPlayerControls(uri)`, reference-counts mounted consumers, and releases the native player once the last one unmounts. Missing/inaccessible files and native failures are caught and surfaced as `state.error`, never thrown.
- `components/AudioPlayerControls.tsx`: reusable Play/Pause + tap-to-seek progress bar + `mm:ss` control, `compact` variant for inline use in list cards.
- `components/NoteDetailModal.tsx`: bottom slide-up sheet (`noteId`, `visible`, `onClose`, `onDeleted`). Fetches the full note itself via `getNoteById` (works uniformly whether the caller has full note data or just a partial RAG citation). Shows transcript, formatted timestamp, status badge (no topic/tag extraction exists in the schema — status substitutes for "metadata"), embedded audio controls, and an atomic delete that pauses playback → `deleteNote` → closes → notifies parent.
- Wired into both `app/index.tsx` (tap a note card to open the modal; inline compact playback directly on cards, including search results) and `app/chat.tsx` (tapping a `[Note N]` citation chip opens the same modal instead of a plain `Alert`).

**Phase 3D Stage 1 — Voice Query Input in Chat**
- `app/chat.tsx` gained a mic button in the input bar using the existing `services/audio/recorder.ts` (`useVoiceRecorder`) and `services/ai/whisper.ts` (`transcribeAudio`).
- States: `isRecordingVoice` (derived directly from `recorder.isRecording`, not duplicated), `isTranscribingVoice`, `recordingDuration` (ticked by a 1s interval while recording).
- Recording → stop → transcribe → auto-submit via a refactored `handleSend(overrideText?: string)`. Voice submissions don't clobber whatever the user had separately typed into the input box.
- Silence detection reuses `isSilentTranscript()`, newly exported from `services/notes/noteManager.ts` (was a private regex used only for voice notes) — both the note-recording flow and the chat voice-query flow now agree on what counts as "Whisper heard nothing" instead of drifting independently.
- Lifecycle safety: a `useFocusEffect` cleanup (via a `recorderRef` to avoid re-running on every render, since `useVoiceRecorder()` returns a new object each render) stops any in-progress recording if the user navigates away from the Chat tab mid-recording.

## Architecture Integrity

- `npx tsc --noEmit` — clean, zero errors, verified after every increment across this whole project.
- `npx expo export --platform android` — bundles clean (1342 modules as of this commit).
- **Hybrid note search**: `hybridSearchNotes()` in `services/notes/noteManager.ts` fuses sqlite-vec cosine-distance ranking with FTS5 keyword ranking via reciprocal rank fusion, filtered to `status = 'embedded'` and Whisper-noise-filtered. This is the *only* search path now — the old vector-only `searchNotes()` was removed; both the Notes tab search bar and RAG chat retrieval go through the same function.
- **Native op-sqlite/FTS5**: `db/client.ts` degrades gracefully (`isFtsAvailable()`) if the linked native build wasn't compiled with FTS5 (`op-sqlite.fts5: true` in `package.json` requires a native rebuild — `npx expo prebuild --clean` + rebuild — to take effect, not just a JS/Metro change). `note_embeddings` (sqlite-vec) has no explicit primary key and relies on `rowid`, joined against `notes.rowid`; `notes_fts` is an FTS5 external-content table kept in sync by triggers using the special `('delete', ...)` command (a plain `DELETE`/`UPDATE` trigger doesn't work correctly against external-content FTS5 tables).
- **Known environment quirk**: this dev machine's only JDK (25, JetBrains Runtime) is too new for the current Android Gradle Plugin's native CMake step. A working JDK 17 was already auto-provisioned by Gradle at `~/.gradle/jdks/eclipse_adoptium-17-amd64-windows.2` — point `JAVA_HOME` at it for any future native (`gradlew`) build rather than the system default.
- Vestigial `entities`/`relationships` schema and the Drizzle ORM dependency were both real technical debt identified in an earlier audit; the unused tables were removed, but `drizzle-orm`/`drizzle-kit` are still installed (only referenced by `db/client.ts`'s unused `getDatabase()` accessor) — safe to remove later, not yet done.

## Next Objective

1. **Phase 3D Stage 2 — Hands-Free Text-to-Speech Output** (executing now in this session): `expo-speech` integration, `services/audio/tts.ts` sanitizer + speak/stop wrapper, auto-read on RAG response completion, per-bubble speaker toggle, lifecycle-safe `stopSpeech()` on navigation away.
2. **Phase 4 — Local On-Device Models**: not yet started or scoped.
