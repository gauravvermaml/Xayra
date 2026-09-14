# Consolidated QA Triage — Xayra Stabilization

Synthesizes `qa/01-lifecycle-state-report.md`, `qa/02-audio-engine-report.md`, `qa/03-concurrency-report.md`, `qa/04-test-strategy-report.md` into one deduplicated, prioritized backlog. Per the plan's ownership split, the native-heap-release and SQLite-transaction-safety findings were audited from two angles by design (Agent 1: where/whether; Agent 3: is it race-safe) — merged into single items below, not double-counted. No code has been changed. This is the backlog to review before any fix work starts.

---

## P0 — data loss, silent corruption, or hang risk

### P0-1. SQLite transaction isolation gap (the most structurally significant finding)
**Owner findings**: Agent 3 (mechanism), Agent 1 (which write paths are exposed).
**What**: `op-sqlite`'s `db.transaction()` issues `BEGIN`/`COMMIT`/`ROLLBACK` via a synchronous call that bypasses the single native worker thread every other `db.execute()` call queues onto. An unrelated statement from a completely different feature (e.g. `retryPendingEmbeddings()` running on screen focus) can get invisibly swept into another feature's open transaction (e.g. `completeToDo()`'s transaction) and share its commit/rollback fate — a write that appears to succeed to its own caller can be silently rolled back by someone else's unrelated failure.
**Why it's #1**: every other transactional write in the app (`deleteNote`, `completeToDo`, `purgeAllNotes`, `mergeMissingNotes`, `mergeMissingToDos`) inherits this exposure. It's invisible today — nothing has surfaced it as a symptom yet — which is exactly the kind of bug that produces "random," device-specific data anomalies with no clear repro, the whack-a-mole pattern this whole exercise exists to stop.
**Fix shape (per Agent 3)**: a JS-level mutex/queue serializing every `db.transaction()` call against every `db.execute()` call on the shared connection — an in-process concurrency primitive, not a durable/resumable design.
**Testable**: yes, against a purpose-built fake `op-sqlite` double once the fix exists (Agent 4 backlog item 2, effort L).

### P0-2. Fire-and-forget to-do extraction — silent, permanent, untraceable loss
**Owner finding**: Agent 1.
**What**: `scheduleToDoExtraction()` (`services/notes/noteManager.ts:172-208`) has zero persisted "extraction pending" state anywhere in the schema and no retry pass. A kill during the (historically 140+ second) extraction step permanently loses every not-yet-written to-do, with no trace it was ever attempted and no self-heal.
**Fix shape**: an extraction-status column on `notes` (mirroring the existing `status`/`retryPendingEmbeddings()` pattern already used for embeddings) plus a retry pass on next launch/focus.
**Testable**: yes — a characterization test today, a positive test once fixed (Agent 4 backlog item 3, effort M/M).

### P0-3. `createVoiceNote` stuck-pending blank note, no self-heal
**Owner finding**: Agent 1.
**What**: a kill between the initial `INSERT` (`status='pending'`) and the follow-up status update leaves a permanently stuck, blank note. `retryPendingEmbeddings()` only ever queries `status='transcribed'`, never `'pending'` — no recovery path exists; the row is only removable via the destructive "Delete All Notes" action.
**Fix shape**: either wrap the two statements in `db.transaction()` (simplest — makes the row never exist in the first place if interrupted) or extend the retry pass to also catch `'pending'` rows.
**Testable**: yes, cleanly (Agent 4 backlog item 4, effort S).

### P0-4. No native-heap release on backgrounding (llama.rn / whisper.rn)
**Owner findings**: Agent 1 (gap mapping), Agent 3 (fix constraint).
**What**: `releaseLocalLlama()` exists (`services/ai/localLlama.ts:1134`) but has zero callers tied to app lifecycle — confirmed via a repo-wide `AppState` grep returning nothing real. The native context (up to ~3.6GB RSS for a 3B model, per the file's own comment) stays fully resident on the C++ heap for the app's entire backgrounded lifetime. Whisper is worse: whisper.rn itself exposes a `.release()` method, but this codebase never calls it — there isn't even an unwired stub.
**Plausible connection to Build 40**: not proven, but consistent — the app's resident footprint peaks right as onboarding's `memoryGuard.ts` watches for LMKD-adjacent pressure, and nothing releases that footprint afterward either.
**Fix constraint (critical, from Agent 3)**: any future release-on-background fix MUST be submitted through `runExclusiveLlamaTask()`, exactly like the three existing calibration-trial callers — calling `releaseLocalLlama()` directly already caused a hang once (a warm-up completion in flight on the context being torn down) and would reproduce the same hang if triggered by backgrounding instead. Whisper has no equivalent exclusive-task queue at all; a Whisper release path needs one built, guarded by the existing `activeTranscriptionCount` signal.
**Named recommendation**: an `AppState` listener in `app/_layout.tsx` (the one file mounted for the app process's entire lifetime), NOT scattered per-screen.
**Testable**: only after it exists (Agent 4 backlog item 1, effort M) — the RSS-drop half stays a manual device check permanently.

---

## P1 — user-visible wrong behavior

### P1-1. Recording never stops competing audio (TTS / note playback / Handsfree)
**Owner finding**: Agent 2. Three related findings, one root cause.
**What**: the "single active audio source app-wide" invariant is enforced asymmetrically — TTS and note playback correctly stop each other, but neither starting a manual recording nor engaging Handsfree ever stops them first. Concretely: (a) `startRecording()` never calls `stopSpeech()`/`pausePlayback()`; (b) engaging Handsfree has the same gap, and can contaminate its own noise-floor calibration (directly touching the already-closed wake-word bug #2's mechanism); (c) the "Listen"/play buttons in `NoteCard`, `ChatSheetContent`, `NoteDetailModal` don't check `recorder.isRecording`/`activeMode.isActive` before playing — tapping "Listen" mid-Handsfree feeds the assistant's own voice into the still-open mic with no echo cancellation (the exact hazard bug #5 was built to prevent, reached via a UI path that fix never covered).
**Fix shape**: extend the existing `stopSpeech()`/`pausePlayback()` calls to also fire from `recorder.startRecording()` and `activeMode.start()`; add `recorder.isRecording`/`activeMode.isActive` checks to the three playback-triggering components.
**Testable**: yes, with RNTL + mocked audio modules (Agent 4 backlog items 3-5, effort S/S/M).

### P1-2. `preferences.ts` lost-update race
**Owner finding**: Agent 3.
**What**: `writePreferences()` does an unguarded read-modify-write on a shared module-level cache with no mutex. Concretely demonstrated: the tier-upgrade/thread-escalation chain and the onboarding calibration call both fire off the same "ready" transition with nothing sequencing them; `recordCompletionSpeed()` (fires after every completion) can race any other writer during ordinary use.
**Fix shape**: a mutex/queue around `writePreferences`, or a compare-and-swap against the cache.
**Testable**: yes, deterministically, no native dependency (Agent 4 backlog item 6, effort S — the cheapest test in the whole backlog).

### P1-3. `beginDownloads()` re-entrancy → duplicate downloads
**Owner finding**: Agent 3.
**What**: no guard prevents the Wi-Fi-resume listener and the "download over cellular" action from both invoking `beginDownloads()` concurrently, producing two Android DownloadManager transfers for the same file — one orphaned permanently.
**Fix shape**: an `isDownloading` guard or status check at the top of `beginDownloads()`.
**Testable**: yes, with a mocked `download-bridge` native module (Agent 4 backlog item 7, effort M).

### P1-4. Recording has no backgrounding resilience at all
**Owner findings**: Agent 1 (transition matrix), Agent 2 (cross-screen instance).
**What**: no foreground service backs recording despite `app.json` declaring the permissions (and not even declaring `FOREGROUND_SERVICE_MICROPHONE` specifically); the in-progress PCM buffer lives only in an unpersisted React ref. Backgrounding mid-recording (home button, or simply navigating to Archive while a Home-screen recording is still running) risks Android's background-mic restrictions silently starving real samples, with total loss on an actual process kill.
**Fix shape**: flagged as a "materially larger native undertaking" by the codebase's own existing doc comment on the equivalent Handsfree limitation — likely a product decision (accept the limitation and warn the user clearly) rather than a quick code fix. Recommend discussing scope before assigning effort.

### P1-5. Silent recording failure on mic-permission revocation / native error
**Owner finding**: Agent 2.
**What**: the native PCM module's entire typed event surface is `"data"` only — there is no `"error"` event, and the native Android loop swallows exceptions with `printStackTrace()` only. A mid-recording permission revocation or hardware error is invisible end-to-end: `isRecording` stays `true`, no alert fires, and the app finalizes whatever partial (possibly empty) audio arrived into a normal-looking note.
**Fix shape**: needs an upstream/patch change to `@fugood/react-native-audio-pcm-stream` to emit an `"error"` event, then a listener + user-facing alert on the JS side.

### P1-6. Download-id persistence race on kill
**Owner finding**: Agent 3.
**What**: a kill between `enqueueDownload()` returning an id and `writePreferences()` persisting it leaves an orphaned native transfer that gets duplicated on next launch. Narrower, kill-timing variant of P1-3.
**Fix shape**: likely resolved as a side effect of whatever fix addresses P1-3, since both stem from `beginDownloads()`'s lack of atomicity between "start a side effect" and "record that we did."

---

## P2 — device/condition-specific degradation

- **P2-1.** Whisper/Llama CPU-contention gate is bounded to a fixed 6s retry, but a real transcription has measured 24.4s under contention (the gate's own justifying evidence exceeds its own cap) — Agent 2.
- **P2-2.** `pipelineStage.ts`'s single global "what's happening" label has no owner/session identity — concurrent note-save + chat-query can show the wrong status — Agent 3.
- **P2-3.** Handsfree `isActive`/`state` can desync after a background/foreground cycle that doesn't kill the process — reads "listening" with nothing having been captured, no resync logic — Agent 1.
- **P2-4.** No audio-focus/incoming-call handling for recording or Handsfree — a real call arriving mid-session is untested by the closed 5-bug wake-word chain and unhandled today — Agent 2.

## P3 — structural risk, no current symptom, or cosmetic

- **P3-1.** Onboarding escape-hatch `setTimeout` cleanup is wired to the wrong function (a discarded inner-IIFE return value); harmless only because the callback re-checks an `unmounted` flag — Agent 1.
- **P3-2.** Fast-Refresh dev-only leak: editing `localLlama.ts`/`localWhisper.ts`/`localEmbeddings.ts` during development loads a second native context on top of the still-resident first one — Agent 1 (dev-only, no production impact).
- **P3-3.** Dead code: `recorder.ts`'s `cancelAndRestart()` and two `asrRouter.ts` functions, built for a "Reset" pill no longer in the UI — Agent 2 (a product decision — rebuild the feature or remove the dead code — not a bug fix).
- **P3-4.** Cancel-tap-vs-natural-completion ordering edge case — a fully-generated good answer can be discarded if cancel lands one JS tick after generation finishes; benign, not a correctness bug — Agent 3.
- **P3-5.** No starvation ceiling on a background job preempted repeatedly — theoretical, no realistic repro for a single-user mobile app — Agent 3.

---

## What's confirmed safe (do not re-audit)

Pulled forward because it matters as much as the bugs: `db.transaction()` itself is genuine (real `BEGIN`/`COMMIT`/`ROLLBACK`, not cosmetic); FTS5 can never desync from `notes` (SQLite trigger atomicity guarantees it); `insertEmbedding()` is genuinely idempotent; the rollback-journal crash-safety guarantee is real and unweakened; no new `<Modal>`+`router.push` instance exists; `useToDos()`, `useChatSession.ts`'s re-entrancy guard, and the orientation lock are all correct; all 5 previously-closed wake-word bugs are confirmed still fixed; recording⟷Handsfree mutual exclusion is correct in both directions; the completion-queue preemption/retry logic is race-free and generalizes correctly to a third job type; a live retrieval read can never produce a torn/dirty read against an in-flight embedding write; `onboardingCalibrationAttemptInFlight` already has the correct durable-recovery design — the one place in the codebase that needed it and has it.

---

## Recommended fix sequencing (for discussion, not yet approved)

1. **P0-1 (SQLite transaction isolation) first**, despite not being the easiest — it's foundational (every transactional write depends on it) and currently invisible, meaning more code is being built on top of an unsafe primitive the longer it waits.
2. **P0-3 and P1-2 together** (quick, independent, high-confidence fixes — a transaction wrap and a preferences mutex).
3. **P0-2** (to-do extraction durability) — same shape as the existing embedding-retry pattern, moderate effort.
4. **P0-4** (native-heap release), respecting Agent 3's `runExclusiveLlamaTask()` constraint — do this after P0-1 lands, since both touch how "exclusive" native/DB operations are coordinated and the two fixes should share a consistent pattern rather than be designed independently.
5. **P1-1** (audio ownership) — high tester-visible value, independent of the above, can run in parallel.
6. **P1-3/P1-6** (download re-entrancy) — independent, can run in parallel.
7. **P1-4/P1-5** (recording resilience/error surfacing) — likely needs a scoping conversation first (P1-4 especially, per its own "materially larger undertaking" flag).
8. P2/P3 items and the Agent 4 test backlog interleaved opportunistically — several P2/P3s are one-line fixes; the highest-value early tests (per Agent 4: the `preferences.ts` race test, the wake-word regression locks, the two P0 characterization tests) can be written alongside whichever fix they correspond to rather than as a separate pass.
