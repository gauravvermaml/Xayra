# Xayra Stabilization — Phase Execution Roadmap

Built from `qa/05-consolidated-triage.md`'s prioritized backlog. **No code has been changed under this document.** Phase 1 is presented in full detail for review per explicit request; Phases 2-3 are scoped at roadmap level and will each get their own detailed pre-execution brief (matching Phase 1's treatment) once the phase before it is signed off.

## Why three phases, and why the split isn't a flat P0→P1→P2→P3 split

The triage backlog has 4 P0s and 6 P1s — cramming all ten into one phase would recreate the exact problem this whole exercise exists to stop: too much simultaneous change with no verification checkpoint in between. Instead, the phases are split by **subsystem and verification method**, so each phase is independently testable and independently revertible:

- **Phase 1 — Data & Concurrency Integrity**: everything living in `db/`, `services/notes/`, `services/todos/`, `services/settings/`, and `services/ai/`'s lifecycle/queue code. Zero UI surface, zero audio hardware dependency. Verifiable almost entirely with Jest against mocked native modules — the cheapest, fastest, most deterministic phase to get right first, and the one the other phases implicitly build on (a fix to how `db.transaction()` is coordinated should exist before more transactional code gets layered on top of it).
- **Phase 2 — Audio & Recording Resilience**: everything in `services/audio/`, `services/ai/activeMode`-adjacent code, and the three playback-triggering components. Requires RNTL for the code-level checks and real device hardware for the parts that are structurally impossible to unit test (does TTS actually go silent in time to prevent audible bleed-through).
- **Phase 3 — Structural Cleanup & Long-Term Test/E2E Infrastructure**: the remaining P2/P3s (mostly one-line fixes or product decisions, not urgent), plus building out the regression-locking test suite and the first Maestro E2E flows so the next round of fixes doesn't need a fresh QA audit to catch what this one found.

This groups all 4 P0s into Phase 1 along with the two P1s that are mechanically the same bug class (unguarded shared async state — `preferences.ts`'s race, `beginDownloads()`'s re-entrancy), and defers the audio-subsystem P1s (P1-1, P1-4, P1-5) to Phase 2 since they need a different verification method entirely. Open to moving items between phases on your feedback — this is a proposal, not a locked sequence.

---

## Phase 1 — Data & Concurrency Integrity

### 1. Exact issues and files

| # | Issue (from triage) | Files touched | Fix shape |
|---|---|---|---|
| 1 | **P0-1** — `db.transaction()` bypasses op-sqlite's own worker-thread queue via a synchronous `executeSync` call, letting an unrelated `db.execute()` get invisibly swept into another feature's open transaction | `db/client.ts` (new serialization primitive — a mutex/queue wrapping both `execute()` and `transaction()` on the shared connection); `services/notes/noteManager.ts` (`deleteNote`, `mergeMissingNotes`, `tryEmbedNote`, `purgeAllNotes`) and `services/todos/todoManager.ts` (`completeToDo`, `mergeMissingToDos`) — update these call sites to go through the new wrapper instead of calling the raw `db` object's `execute`/`transaction` directly | A JS-level mutex in `db/client.ts`: any `transaction()` call acquires a lock before issuing `BEGIN` and releases it after `COMMIT`/`ROLLBACK`; any plain `execute()` call waits for that lock to clear before it's allowed to queue. This is additive to op-sqlite, not a fork of it — no native code changes needed. |
| 2 | **P0-3** — `createVoiceNote()`'s two un-transacted statements can leave a permanently stuck blank note on a kill between them | `services/notes/noteManager.ts:263-272` | Wrap the initial `INSERT` and the status-update in `db.transaction()` using the now-safe wrapper from item 1 — if interrupted, the row simply never exists rather than existing half-written. Simplest of the four P0s once item 1 lands. |
| 3 | **P0-2** — `scheduleToDoExtraction()` has no persisted "pending extraction" state and no retry pass; a kill during extraction silently loses to-dos forever | `db/schema.ts` (new column on `notes`, e.g. `extraction_status`); `services/notes/noteManager.ts` (`scheduleToDoExtraction`, plus a new `retryPendingExtractions()` mirroring the existing `retryPendingEmbeddings()` at line 449) | Mark extraction as attempted-but-incomplete before it starts, complete once the to-do batch is written; a retry pass invoked from the same trigger points `retryPendingEmbeddings()` already uses (app focus / cold start). Mirrors an existing, proven pattern in this codebase rather than inventing a new one. |
| 4 | **P0-4** — no `AppState`-driven release of the `llama.rn`/`whisper.rn` native context on backgrounding; Whisper has no release path at all | `app/_layout.tsx` (new `AppState` listener — the one file mounted for the app's entire process lifetime); `services/ai/localLlama.ts` (route any background-triggered release through the existing `runExclusiveLlamaTask()`, never call `releaseLocalLlama()` directly — this exact direct-call pattern already caused a hang once); `services/ai/localWhisper.ts` (new `releaseWhisperContext()` function plus an exclusive-task-equivalent guard built on the existing `activeTranscriptionCount` signal, since no such serialization primitive exists for Whisper today) | Sequenced deliberately after item 1, since both are "coordinate access to an exclusive native/DB resource" problems and should share a consistent locking pattern rather than be designed independently. |
| 5 | **P1-2** — `writePreferences()`'s unguarded read-modify-write can silently drop one of two overlapping writers' patches | `services/settings/preferences.ts:106-128` | A mutex/queue around `writePreferences`, or a compare-and-swap against the in-memory cache before committing. Cheapest, most deterministic fix in Phase 1. |
| 6 | **P1-3 / P1-6** — `beginDownloads()` has no re-entrancy guard; two concurrent triggers (Wi-Fi-resume listener + "download over cellular" tap) produce a duplicate, orphaned Android DownloadManager transfer; a kill between `enqueueDownload()` returning an id and persisting it produces the same symptom | `services/ai/modelDownloadManager.ts:521-608` | An `isDownloading` guard (or a check against `currentStatus.status`) at the top of `beginDownloads()`, closing both the concurrent-caller race and, as a side effect, narrowing the kill-timing variant's window. |

**Explicitly deferred out of Phase 1** (tracked, not forgotten): P1-1 (audio ownership), P1-4 (recording backgrounding resilience), P1-5 (silent recording failure) → Phase 2. All P2/P3 items → Phase 3.

### 2. Minimal Jest test infrastructure for Phase 1

Per Agent 4's tooling recommendation (`qa/04-test-strategy-report.md`), scoped down to exactly what Phase 1 needs — no RNTL, no Maestro, no component tests in this phase, since nothing in Phase 1 touches UI.

**One-time setup** (proposed, not yet installed):
- `devDependencies`: `jest`, `jest-expo`, `@types/jest`.
- `package.json`: `"scripts": { "test": "jest" }`; a standalone `jest.config.js` with `module.exports = { preset: "jest-expo" }` (a standalone file rather than inline `package.json` config, so `testPathIgnorePatterns`/`transformIgnorePatterns` can be layered on later without crowding `package.json`).
- A hand-written fake `op-sqlite` double under `__mocks__/@op-engineering/op-sqlite.ts` — a small in-memory implementation of `execute()`/`transaction()`/`executeSync()` against a plain array/Map, deliberately modeling the REAL split Agent 3 found (synchronous `BEGIN`/`COMMIT` vs. a separately-queued `execute()`) so the fix's correctness is actually exercised, not mocked away. This one fake backs every test below.

**Tests to write, one per fix above** (all against the fake DB double, no real device needed):

1. *(locks in item 1 — the mutex/queue)* `A db.execute() call issued while a db.transaction() is open does not commit until the transaction resolves` — drive the fake double to simulate the real interleaving-if-unserialized shape, assert the new `db/client.ts` wrapper blocks the interleaved call until the transaction settles, and — critically — a rollback of the transaction does not silently strand the interleaved call's own promise as "resolved" the way it does today.
2. *(locks in item 2)* `createVoiceNote leaves no row at all if interrupted between its two statements` — force the fake double's second statement to throw mid-transaction, assert zero rows exist afterward (today's behavior — one stuck `'pending'` row — is the regression this test prevents).
3. *(locks in item 3)* `scheduleToDoExtraction marks extraction pending before starting and complete after, and a retry pass picks up an interrupted note` — two tests: a characterization test proving the new status column transitions correctly on the happy path, and a recovery test that kills the fake extraction mid-batch and confirms `retryPendingExtractions()` finds and re-processes the note.
4. *(locks in item 4)* `An AppState background transition releases the Llama/Whisper context through the exclusive-task queue, never directly` — mock `AppState.addEventListener`, fire a synthetic `"background"` event, assert `releaseLocalLlama()` was invoked *via* `runExclusiveLlamaTask()` (spy on the queue entry point, not the release function directly) — this is the one test in Phase 1 that only proves the JS-level coordination is correct; the actual native RSS drop stays a manual `adb shell dumpsys meminfo` check (see verification criteria below).
5. *(locks in item 5)* `Two concurrent writePreferences calls do not silently drop either patch` — mock `expo-file-system`'s read/write with an in-memory string, fire two overlapping `writePreferences()` calls, assert the final state contains both patches.
6. *(locks in item 6)* `beginDownloads called twice concurrently enqueues exactly one native download per phase` — mock the `download-bridge` native module's `enqueueDownload()` as a call counter, fire `beginDownloads()` twice without awaiting the first, assert it was called once per phase.

Every test above is written as a **failing characterization test first** (proving the bug exists against current code), then flipped to a passing regression test once its corresponding fix lands in the same changeset — matching Agent 4's recommended discipline of never writing a test against a fix that doesn't exist yet.

### 3. Verification criteria for completing Phase 1

Phase 1 is done when **all** of the following hold, not just "the six tests pass":

- [ ] All 6 new Jest tests (plus any sub-tests, e.g. item 3's two-part test) pass.
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx expo export --platform android` clean.
- [ ] Since item 4 touches native-adjacent lifecycle code (though no native Kotlin itself changes — this is pure JS/TS wiring an existing native binding into `AppState`), a real native rebuild is run per `CLAUDE.md`'s own rule (`npx expo prebuild --clean --no-install` + `npx expo run:android`) rather than trusting `tsc`/`expo export` alone.
- [ ] **Manual on-device confirmation of item 4's actual effect** (the one thing Jest cannot prove): load the app on the Pixel 9, warm the Llama context, background the app, and confirm via `adb shell dumpsys meminfo <package>` that RSS actually drops — the automated test only proves the JS-level call sequencing is correct, not that the native library's `.release()` genuinely frees memory as documented.
- [ ] **A live repro-and-fix confirmation for each P0**, not just unit-test green: (a) for item 1, re-run the scenario Agent 3's report describes (an embedding retry pass running concurrently with a to-do completion) and confirm via logging/inspection that the interleaving no longer occurs; (b) for item 2, kill the process mid-`createVoiceNote` on-device and confirm no stuck row appears in Archive; (c) for item 3, kill the process mid-extraction on-device (the same repro method Agent 1's report specifies — force-stop timed against the `[transformationEngine]` log line) and confirm the to-do appears after relaunch instead of vanishing.
- [ ] No regression against the "known-safe" list from Agent 1/Agent 3's reports — specifically re-confirm `deleteNote()`/`completeToDo()`/`purgeAllNotes()`/`mergeMissingNotes()`/`mergeMissingToDos()` still behave correctly now that they route through the new `db/client.ts` wrapper (these were correct before; the wrapper must not become a new source of bugs in already-working code).
- [ ] Each of the 6 fixes lands as its own separate, reviewable commit (not one giant commit) — consistent with `CLAUDE.md`'s "prefer specific `git add`" convention and making it possible to bisect if Phase 2 or Phase 3 later surfaces a regression traceable to one of these.
- [ ] This roadmap doc and `qa/05-consolidated-triage.md` updated to mark Phase 1's six items closed, with a short note on what was actually built (matching this project's existing documentation discipline in `PROJECT_STATE_HANDOFF.md`).
- [ ] Explicit sign-off from you before Phase 2 execution begins — same gate as this whole QA process has used throughout.

---

## Phase 2 — Audio & Recording Resilience (roadmap-level; full brief before execution)

**Scope**: `services/audio/{recorder,player,tts,activeMode}.ts`, `components/{NoteCard,ChatSheetContent,NoteDetailModal}.tsx`.

**Issues**: P1-1 (recording/Handsfree never stop competing TTS/playback; playback-triggering components never check recording/Handsfree state — three related findings, one root cause), P1-4 (no backgrounding resilience for recording — likely needs a scoping conversation before an effort estimate, per the codebase's own existing doc-comment acknowledging the equivalent Handsfree limitation is a "materially larger undertaking"), P1-5 (silent recording failure on mic-permission revocation — needs a patch to `@fugood/react-native-audio-pcm-stream` to add an `"error"` event), plus the audio-adjacent P2s (P2-1 contention-gate cap, P2-3 Handsfree desync after background/foreground, P2-4 no audio-focus/incoming-call handling) folded in since they share the same files and the same manual-device verification method.

**Test infrastructure**: React Native Testing Library added on top of Phase 1's Jest base, with `player.ts`/`tts.ts`/`recorder.ts`/`activeMode.ts` mocked as simple call-counters — proving the CODE calls the right stop/check functions in the right order (Agent 4 backlog items 3-5). The parts that are structurally impossible to unit test (does audio actually go silent in time, does a real headset disconnect behave as assumed) move to Agent 4's manual device-smoke checklist section 5d, run across all three pool devices.

**Verification will include**: RNTL suite green; the 5-bug wake-word regression check re-run live one more time after these changes (since Finding 2/3 touch the exact calibration/echo-guard mechanisms those fixes depend on); the full section 5d manual checklist executed on Pixel 9, Redmi Note 8 Pro, and Galaxy A50.

A detailed Phase 2 execution brief (matching this document's Phase 1 treatment) will be presented for review once Phase 1 is signed off.

---

## Phase 3 — Structural Cleanup & Long-Term Test/E2E Infrastructure (roadmap-level; full brief before execution)

**Scope**: remaining P2 (`pipelineStage.ts` cross-flow overwrite) and all P3 items (onboarding escape-hatch timer cleanup bug, Fast-Refresh dev-only native-singleton leak, the dead `cancelAndRestart`/`restartListening`/`cancelListening` code — needs a product decision, not just a fix: rebuild the "Reset mid-recording" feature or remove the dead code — the benign cancel-ordering edge case, and the theoretical background-job-starvation ceiling).

**Also in scope**: building out the remainder of Agent 4's prioritized test backlog not already covered by Phases 1-2 (the two wake-word regression locks, the single-biometric-prompt test, the cancel-gesture no-trace-left test, the retrieval-relevance-floor boundary test, the completion-queue ordering test) and standing up the first Maestro E2E flows (`record-transcribe-save`, `ask-and-answer`, `onboarding-happy-path`) so future changes to this codebase get a real regression net instead of requiring a fresh multi-agent QA audit every time.

**Verification will include**: full automated suite (Jest + RNTL + the new Maestro flows) green; the complete Agent 4 manual device-smoke checklist (section 5, all subsections) run once as a full release-gate rehearsal; a decision recorded on the dead-code items rather than left ambiguous.

A detailed Phase 3 execution brief will be presented for review once Phase 2 is signed off.

---

## Status

Phase 1 above is ready for your review. No code has been changed. Awaiting explicit go-ahead before implementing any of the six Phase 1 fixes or writing the Jest test infrastructure.
