# Agent 3 — Asynchronous & Concurrency Audit

Scope: `services/ai/localLlama.ts`, `services/ai/transformationEngine.ts`,
`services/ai/modelDownloadManager.ts`, `services/ai/useChatSession.ts`,
`services/ai/memoryGuard.ts` + `components/OnboardingSetupScreen.tsx`,
`services/settings/preferences.ts`, plus the concurrency angle of the two
★ New shared briefs (native heap/OOM, SQLite transaction safety), cross-checked
against `services/notes/noteManager.ts`, `services/todos/todoManager.ts`,
`db/client.ts`, `db/schema.ts`, and the `@op-engineering/op-sqlite` native
source actually installed in `node_modules`. Read-only; no files under
`services/`, `components/`, `app/`, `modules/` were modified.

**Framing this report holds to throughout**: a *JS-catchable async race* is a
bug where two Promises/callbacks interleave in an unexpected order but the
process keeps running — a `try/catch`, a queue, or a ref guard can fix it. A
*whole-process native OOM kill* ends the JS thread, every in-memory module
variable, and every React component's state in the same instant — nothing in
this codebase's JS can observe it happening or run a handler in response. The
two are never treated as the same failure mode anywhere below.

---

## Findings table

| Severity | File:Line | Scenario | Why it breaks | Repro/verification method |
|---|---|---|---|---|
| P0 | `node_modules/@op-engineering/op-sqlite/src/functions.ts:250-271` (transaction body) vs `cpp/DBHostObject.cpp:399-413` (`executeSync`) + `cpp/DBHostObject.cpp:432-440` (`execute` via `promisify(..., thread_pool, ...)`) | Any `db.transaction()` block (`services/notes/noteManager.ts:336` `deleteNote`, `:402` `mergeMissingNotes`; `services/todos/todoManager.ts:322` `mergeMissingToDos`, `:480` `completeToDo`) runs concurrently with ANY unrelated plain `db.execute()` call elsewhere in the app on the same shared connection (`getRawDatabase()`, `db/client.ts:88-91`) — e.g. `noteManager.ts`'s `retryPendingEmbeddings()` (`:449-468`, looping `tryEmbedNote`/`insertEmbedding`/`updateNoteStatus`) running on screen-focus while the user taps "complete" on a to-do. | op-sqlite's JS `transaction()` issues `BEGIN TRANSACTION;` / `COMMIT;` / `ROLLBACK;` via `executeSync` — a direct, synchronous call on the calling JS thread, bypassing the native thread pool entirely — while every statement *inside* the transaction body, and every OTHER unrelated `db.execute()` call anywhere in the app, is queued onto ONE dedicated native worker thread (`cpp/OPThreadPool.cpp:14`, `numberOfThreads = 1`, hardcoded). Nothing coordinates the two paths. Since it's the same connection, an unrelated statement that gets queued (or synchronously fires via its own `executeSync`) between a transaction's `BEGIN` and its `COMMIT` executes *as part of* that open transaction from SQLite's point of view — not blocked, not erroring, just silently swept in. If the transaction later rolls back, the unrelated caller's own `await db.execute(...)` had ALREADY resolved successfully with no error, yet its write is gone. | Not deterministically reproducible on demand (needs precise timing), but plausible from code inspection per the severity taxonomy's own P0 definition. To exercise it: hold `retryPendingEmbeddings()` mid-loop (e.g. temporarily add an artificial delay between its `tryEmbedNote` calls) and, while it's running, complete a to-do that has `recurrence !== "none"` (so `completeToDo`'s transaction does two statements with a real await gap between them) — then force one arm of `completeToDo`'s transaction to throw (e.g. a constraint violation) and confirm whether an embed statement that landed in the window is rolled back with it. |
| P1 | `services/settings/preferences.ts:106-128` | Two independent async call chains write preferences at overlapping times — concretely, `modelDownloadManager.ts:234-237`'s `void (async () => { await maybeAttemptTierUpgrade(); await maybeAttemptThreadEscalation(); })()` (fired from `setStatus`, `:222`) and `OnboardingSetupScreen.tsx:221`'s `await runOnboardingThreadCalibration(...)` are BOTH triggered off the exact same `modelDownload.status === "ready"` transition, with nothing sequencing one after the other. More generally, `modelPerformanceTracker.ts:42-49`'s `recordCompletionSpeed()` (fired via `void recordCompletionSpeed(...)` at `localLlama.ts:852`, after literally every completed RAG answer or extraction) can land at the same moment as ANY other preferences writer during ordinary use — e.g. a user tapping "Download over Mobile Data" (`allowCellularDownloadAndResume`, `modelDownloadManager.ts:604-608`) while a to-do extraction's completion is also settling. | `writePreferences()` does an unguarded read-modify-write on a shared module-level `cache` (`preferences.ts:104`): `const current = await readPreferences(); const next = {...current, ...patch}; cache = next; await FileSystem.writeAsStringAsync(...)`. If two calls both resolve `readPreferences()` to the same pre-write snapshot before either write lands, the SECOND writer's `next` is built from a `current` that doesn't include the FIRST writer's patch — the first writer's change is silently discarded from both `cache` and the on-disk file the instant the second write completes, a classic lost-update race. There is no mutex, no versioning, no merge-conflict detection anywhere in this file. | Add a `console.log(Date.now(), patch)` inside `writePreferences` and trigger two of the call sites above within the same tick (e.g. call `recordCompletionSpeed(5)` and `allowCellularDownloadAndResume()` back-to-back without awaiting either) — observe that only the later write's fields survive in the next `readPreferences()` call. |
| P1 | `services/ai/modelDownloadManager.ts:521-529` (`watchForWifiThenResume`) vs `:604-608` (`allowCellularDownloadAndResume`) vs `:531-602` (`beginDownloads`) | A user taps "Download over Mobile Data" on the cellular-blocked callout at (or immediately after) the exact moment Wi-Fi becomes available on its own. `watchForWifiThenResume`'s listener fires `void beginDownloads(tier)`; `allowCellularDownloadAndResume()` calls `stopWatchingForWifi()` (removing the JS listener) and then ALSO calls `await beginDownloads(await resolveActiveLlamaTier())`. | `beginDownloads()` has no re-entrancy guard at all — no `isDownloading` flag, no check of `currentStatus.status`. Two concurrent invocations both read `isWhisperModelDownloaded()`/`isChatModelDownloaded()` as false, both call `resetTelemetry()` (stomping each other's telemetry state), and both call `downloadFileViaSystemManager()` for the same phase — each independently calls `enqueueDownload()` (since neither has yet seen the other's `nativeDownloadIds` write), creating TWO separate Android DownloadManager transfers for the same file. Whichever `writePreferences({nativeDownloadIds: ...})` lands last (see the P1 above — this is itself an instance of the general preferences race) is the only ID this app ever polls again; the other DownloadManager transfer is permanently orphaned (keeps consuming bandwidth/storage, never queried, never cancelled). | Simulate by calling `allowCellularDownloadAndResume()` twice in quick succession (or once alongside a manually-fired `Network.addNetworkStateListener` WIFI event) before either has resolved, then inspect `adb shell dumpsys download` for duplicate enqueued transfers for the same destination filename. |
| P1 | `services/settings/preferences.ts:106-128` write path + `modelDownloadManager.ts:469-471` (`downloadFileViaSystemManager`'s enqueue write) | A process kill lands in the gap between `enqueueDownload()` returning an id (`:470`) and `await writePreferences({nativeDownloadIds: ...})` (`:471`) actually persisting it. | The native DownloadManager transfer is OS-owned and keeps running after the kill, but nothing on disk points to its id. On relaunch, `downloadFileViaSystemManager` reads `prefs.nativeDownloadIds[phaseKey] === undefined` and calls `enqueueDownload()` again — a second, duplicate transfer for the same file, with the first now orphaned exactly as in the finding above. This is a narrower version of the same root cause (no atomicity between "start an external side effect" and "persist the fact that we did"), worth tracking separately since it's a *kill-timing* race rather than a *concurrent-caller* race. | Not independently testable without killing the process at a specific instruction boundary; flagged from code inspection per the "plausible" clause of the severity taxonomy. Onboarding's own documented history (Build 40, LMKD kills mid-onboarding) makes this a realistic window, not a hypothetical one. |
| P2 | `services/ai/pipelineStage.ts:30-36` vs call sites `services/notes/noteManager.ts:137,139,157` and `services/ai/rag.ts:169,197,206,214` | A background note save (`tryEmbedNote`, setting `"understanding"`/`"saving"`, always clearing to `null` in its `finally`) and a live chat query (`generateRAGAnswer`, setting `"retrieving"`/`"answering"`) can run concurrently — nothing prevents saving a second note while a chat answer is still generating, or vice versa. | `pipelineStage.ts` is one bare module-level `current: PipelineStage \| null` with no owner/session identity — `setPipelineStage()` from either flow unconditionally overwrites the single global value and fans it out to every subscriber. Whichever flow's stage-set (or `finally`'s `setPipelineStage(null)`) executes last wins globally, so a subscriber (e.g. `ChatSheetContent`'s streaming-answer row) can flash the wrong milestone label — or have its `"answering"` stage prematurely nulled out by an unrelated note-save's `finally` block completing at the same moment. | Start a chat query, then immediately save a text note before the answer finishes streaming; watch the chat UI's stage label for content unrelated to `PIPELINE_STAGE_LABELS`'s query-side entries. |
| P3 | `services/ai/localLlama.ts:907-912` (`cancelActiveLlamaCompletion`) vs `:815-868` (`processCompletionQueue`'s completion branch) | The user's cancel tap sets `runningCompletion.job.userCancelled = true` at the exact JS-thread instant the native `completion()` promise has already resolved with a complete, valid answer but its `.then` callback hasn't run yet (both are plain JS scheduling — no true concurrency, but the ordering between "native promise settles" and "cancel button's synchronous handler runs" is not something app code controls). | The settle handler checks `job.userCancelled` FIRST (`:824-830`), so a fully-generated, good answer is discarded and rejected as `LlamaCancelledError` purely because the cancel tap landed a JS tick after generation genuinely finished. Not a double-fire or data-corruption bug (a Promise settles exactly once, so "cancelled AND completed" handlers can never both run) — a benign, rare UX edge case, not a correctness bug. | Hard to force deterministically; documented here as a structural risk from reading the settle-order logic, not an on-device repro. |
| P3 | `services/ai/localLlama.ts:780-798` (`enqueue`) | A background job (extraction or boot warmup) can be preempted repeatedly, forever, if interactive queries keep arriving back-to-back before it ever gets a full run to completion — each preemption re-enqueues it at the BACK of the background band (`:839-841`, `:863-864`), which is correct per-preemption but has no starvation ceiling across many preemptions. | Purely theoretical for a single-user mobile app (a human can't generate interactive queries fast enough in practice to starve a background job indefinitely), but structurally there is no retry cap or escalating priority on a job preempted N times. | No realistic repro; flagged as a structural risk with no current symptom (matches the P3 definition exactly). |

---

## Narrative

### A. The `preferences.ts` lost-update race is the root cause behind several symptoms, not one bug

`writePreferences()` (`services/settings/preferences.ts:122-128`) is the single
choke point every other finding in this report about "two things racing to
write shared state" ultimately reduces to:

```ts
export async function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const current = await readPreferences();
  const next = { ...current, ...patch };
  cache = next;
  await FileSystem.writeAsStringAsync(preferencesPath(), JSON.stringify(next));
  return next;
}
```

There is no mutex around this function and no compare-and-swap against the
`cache` it reads. Any two calls whose `await readPreferences()` both resolve
before either call's own write lands will silently discard whichever patch
committed first, in both the in-memory `cache` and the on-disk file — the loss
is permanent for that process's lifetime, and the on-disk file matches
whichever write happened to land last. This is a genuinely different failure
class from the OOM-kill state loss discussed in section B below: this is a
plain **JS-catchable-in-principle race** — a queue or a mutex around
`writePreferences` would fix it outright — but nothing in the codebase
currently does that.

### B. Native heap & OOM — JS-catchable race vs. whole-process kill, kept explicitly separate

**(a) Would a future release-on-background path race an in-flight completion?**
Every point where JS code currently assumes the shared llama.cpp context is
alive already goes through ONE serialization point:
`runQueuedLlamaCompletion()` (`localLlama.ts:885-893`) for ordinary completions,
and `runExclusiveLlamaTask()` (`localLlama.ts:935-948`) for anything that needs
to tear down and reload the context (`attemptTierUpgrade`, `attemptThreadEscalation`,
`attemptOptimisticThreadCalibration`). The doc comment on `runExclusiveLlamaTask`
(`:914-934`) records that an EARLIER version of this code called
`releaseLocalLlama()` directly from a calibration trial and hung the app,
because a warm-up completion was still in-flight on the very context being torn
down — i.e. this exact race already happened once and was fixed by routing
every release/reload through the shared queue. **If an `AppState`-driven
release-on-background is ever added (Agent 1's finding: it does not exist
today, confirmed — no `AppState` import anywhere in `services/ai/localLlama.ts`
or `services/ai/localWhisper.ts`)**, it MUST be submitted as a `QueuedTask` via
`runExclusiveLlamaTask()`, exactly like the three existing callers, and never
call `releaseLocalLlama()` (`:1134-1142`) directly — doing so would reproduce
the exact hang already fixed once, this time triggered by an app backgrounding
mid-answer instead of mid-calibration. This is a concrete, actionable
constraint on any future fix, not merely "be careful."

Whisper has no equivalent exclusive-task queue at all: `localWhisper.ts` has no
`runExclusiveLlamaTask`-style serialization primitive, and `resetWhisperContext()`
(`:93-96`) is called directly and synchronously from `modelDownloadManager.ts:565`
today (safe only because it fires after a whisper download completes, when no
transcription can possibly be in flight). If a future release-on-background
were added for Whisper's context, it would need its own equivalent guard
against a concurrent `transcribeAudioLocal()` call — `activeTranscriptionCount`
(`:58-62`) already exists as exactly the signal such a guard would need to
check, but nothing currently wires it to a release path.

**(b) What actually happens today if the process is OOM-killed mid-completion —
and is anything left stuck?** Here the audit's finding is reassuring, and
worth stating plainly rather than assumed: **nothing in this codebase's
concurrency-relevant JS state is persisted to disk except `preferences.ts`'s
fields.** The completion queue (`waitingCompletions`, `runningCompletion`,
`isCompletionRunning` — all plain module-level `let`s, `localLlama.ts:762-778`)
and `useChatSession.ts`'s `isSendingRef`/`isSending` (React `useRef`/`useState`,
scoped to a live component instance) live ONLY in the process's memory. A
whole-process OOM kill takes the JS thread, every module-level variable, and
every React component's state down in the same instant — there is no "half
of the app died" state to leave stuck, because on the next launch every one of
these re-initializes fresh (`isCompletionRunning = false`, `runningCompletion =
null`, a brand-new `useChatSession()` hook instance with `isSendingRef.current
= false`). No `try/catch` is what makes this true — a kill doesn't run
finally blocks, doesn't reject pending promises, doesn't call any handler at
all — it's true only because none of this state was ever written anywhere a
future process would read it back from.

The ONE piece of state in this whole audit area that IS persisted, and
therefore genuinely CAN be left "stuck" by a kill, is
`onboardingCalibrationAttemptInFlight` (`preferences.ts:52-66`) — and this
codebase already ships the correct fix for it: `runOnboardingThreadCalibration()`
(`modelDownloadManager.ts:842-859`) explicitly checks whether this flag is
still `true` on entry and, if so, treats it as proof the previous attempt died
mid-trial and skips straight to the conservative thread count rather than
retrying the same heavier path. This is the single correct instance in the
codebase of the "durable, resumable, not a try/catch" design the plan calls
for — worth naming as a positive pattern other persisted in-flight flags
should follow if any are added later. `tier3BStatus`/`threadEscalationStatus`
deliberately have NO equivalent "in-flight" flag — a kill mid-trial simply
leaves them at `"not_attempted"`, and the next "ready" transition retries the
whole attempt from scratch, which is safe here specifically because (unlike
onboarding calibration) there's no product reason to avoid re-attempting a
heavier trial after a kill for these two triggers. This asymmetry is
intentional, not a gap — listed again under "known-safe" below.

**(c) Can a live retrieval read race an in-flight `tryEmbedNote()` write, and
what does op-sqlite/SQLCipher actually do?** This required checking the
installed native library, not assuming from the plan's framing. Two facts,
confirmed by reading `node_modules/@op-engineering/op-sqlite`'s own C++:

1. **No `PRAGMA journal_mode` or `PRAGMA busy_timeout` is ever set** — not in
   `db/client.ts`, not anywhere in op-sqlite's own native open path
   (`cpp/DBHostObject.cpp`, `cpp/bridge.cpp` — grepped directly, zero matches
   for `journal_mode`/`busy_timeout`/`PRAGMA`). The database runs at SQLite's
   compiled-in default: rollback-journal mode, `busy_timeout = 0`. In the
   abstract, that combination means a **lock-contention error (`SQLITE_BUSY`),
   surfaced immediately with no retry/backoff**, is the theoretically correct
   answer to "what happens on contention" — and nothing in `services/` catches
   `SQLITE_BUSY`/"database is locked" anywhere (grepped `services/`, zero
   matches).
2. **In practice, that error can't actually occur here**, because op-sqlite
   serializes every operation on one connection onto exactly ONE dedicated
   native worker thread (`cpp/OPThreadPool.cpp:14`, `numberOfThreads = 1`,
   hardcoded, never raised) via `promisify(rt, thread_pool, ...)`
   (`cpp/DBHostObject.cpp:432-440` for the async `execute()` every `services/`
   call goes through). Two statements on the same connection therefore never
   truly run "at the same time" at the SQLite engine level — they run one at a
   time, in FIFO submission order, each to full completion (autocommit
   `INSERT`/`UPDATE` calls are one statement = one implicit transaction) before
   the next starts. So `tryEmbedNote()`'s `insertEmbedding()` then
   `updateNoteStatus(id, "embedded")` (`noteManager.ts:140-141`, two separate
   queued tasks with a real `await` gap between them) can never be "torn" from
   a concurrent `hybridSearchNotes()` SELECT's point of view — the SELECT
   either runs before both, between them (seeing the embedding row but
   `status` still `"transcribed"` — already-known, already-documented,
   already-safe-by-design behavior per the code's own comments and
   `WHERE status = 'embedded'` filter), or after both. **A torn/dirty read
   never happens; the actual behavior is "stale-but-consistent," never
   "corrupted."**

   The real cost of this single-worker-thread design is not a lock error —
   it's **queue-position latency with no priority scheme**, which the plan's
   own framing anticipated ("these are two separate resources this app
   currently only arbitrates one of"): `localLlama.ts`'s completion queue has
   an explicit interactive/background priority split; the SQLite side has
   NONE. A large batch of DB writes (`reembedAllNotesInBackground`,
   `db/client.ts:251-284`, run at every cold DB open after a dimension
   migration; or `retryPendingEmbeddings`'s loop, `noteManager.ts:449-468`, run
   on every screen focus) queues its statements on the exact same single
   worker thread a live `hybridSearchNotes()` SELECT is waiting behind — a
   live query's retrieval can be measurably delayed behind an unrelated
   background batch with no way to jump the line, unlike the Llama side where
   `"interactive"` already jumps ahead of `"background"`.
   As covered in the findings table above (P0), the same single-worker-thread
   design does NOT protect a `db.transaction()`'s `BEGIN`/`COMMIT` from being
   interleaved with unrelated statements, because those two calls bypass the
   worker thread queue entirely via `executeSync` — this is the more serious
   half of the SQLite concurrency picture, and it's a genuine transactional-
   isolation gap, not merely a latency one.

### C. Completion-queue preemption/retry logic — checked correct

`enqueue()`/`processCompletionQueue()` (`localLlama.ts:780-876`) were read
statement-by-statement rather than skimmed. The preemption retry path is
race-free by construction: when a preempted background job's settle handler
calls `enqueue(priority, job)` again (`:839-841`/`:863-864`), that inner call's
own `processCompletionQueue()` invocation is a guaranteed no-op because
`isCompletionRunning` is still `true` at that point (the outer `.finally` that
flips it back to `false` hasn't run yet) — so the re-enqueued job cannot
possibly be dequeued before the outer job's teardown finishes. This is
correct, deliberate, and matches its own doc comments. Boot warmup
(`prewarmLocalLlama`, tagged `"background"`, `:1111`) goes through the exact
same code path as extraction — the Build 36 preemption fix generalizes to a
third concurrent job type (warmup) with no special-casing needed, since
warmup carries no priority-specific behavior of its own. This is listed again
under "known-safe" below.

---

## `preferences.ts` state-mutation map

| Field | Readers | Writers | Can two writers legitimately overlap in time? |
|---|---|---|---|
| `allowCellularDownloads` | `runInitialCheck` (`modelDownloadManager.ts:916`) | `allowCellularDownloadAndResume` (`:605`, user-tap-triggered) | Rarely more than once per install (a one-time consent tap), but nothing prevents it landing mid-write from another field's writer — see general race in section A. |
| `nativeDownloadIds` | `downloadFileViaSystemManager` (`:467-468`) | `downloadFileViaSystemManager`'s enqueue write (`:471`), `clearPersistedNativeDownloadId` (`:447-451`, called from `:478` on success and `:488` on terminal failure) | **Yes, concretely** — `watchForWifiThenResume`'s listener and `allowCellularDownloadAndResume()` can both call `beginDownloads()` → `downloadFileViaSystemManager()` for the same `phaseKey` at once (P1 finding above); each writes this field independently with no coordination. |
| `performanceSamples` | `getAverageTokensPerSecond` (`modelPerformanceTracker.ts:55`) | `recordCompletionSpeed` (`:48`, fires after every completion, un-awaited by its caller at `localLlama.ts:852`), `resetPerformanceSamples` (`:67`, called from `maybeAttemptTierUpgrade`/`maybeAttemptThreadEscalation` after a trial) | **Yes** — `recordCompletionSpeed` fires after every single RAG answer or extraction throughout normal use, completely decoupled from anything else in the app; it can and will overlap with any other writer below given enough usage. |
| `tier3BStatus` | `maybeAttemptTierUpgrade` (`:637`) | `maybeAttemptTierUpgrade` (`:658`, `:704`, `:714`) | Not with itself (single sequential function), but see the onboarding-window overlap with `runOnboardingThreadCalibration` below. |
| `llamaThreadCount` | `computeInferenceThreadCount` (`localLlama.ts:66-69`) | `maybeAttemptThreadEscalation` (`:789`), `runOnboardingThreadCalibration` (`:847-851`, `:864-868`) | **Yes, in a narrow onboarding-only window** — both `maybeAttemptTierUpgrade`/`maybeAttemptThreadEscalation` (fired from `setStatus`'s "ready" hook, `:222-238`) and `runOnboardingThreadCalibration` (fired from `OnboardingSetupScreen.tsx`'s completion-sequence effect, `:221`) are triggered off the SAME "ready" transition with nothing sequencing one after the other. In the common first-install case this is a near no-op (no performance history yet, so `maybeAttemptTierUpgrade`/`maybeAttemptThreadEscalation` early-return before writing anything) — but the "3B model already on disk, `tier3BStatus` still `not_attempted`" branch (`:647-660`) writes immediately with NO history check, so a tester who manually pushed a 3B `.gguf` before first launch WILL hit a genuine overlapping-writer window. |
| `threadEscalationStatus` | `maybeAttemptThreadEscalation` (`:749`) | `maybeAttemptThreadEscalation` (`:789`, `:794`), `runOnboardingThreadCalibration` (`:849`, `:866`) | Same onboarding-window overlap as `llamaThreadCount` above. |
| `onboardingCalibrationAttemptInFlight` | `runOnboardingThreadCalibration` (`:844`) | `runOnboardingThreadCalibration` (`:847-851` sets `false`, `:861` sets `true`, `:864-868`/`:873` set `false`) | Guarded against concurrent same-process re-entry by `OnboardingSetupScreen.tsx`'s `completionStarted` ref (`:138`, `:201`) and `modelDownloadManager.ts`'s `initStarted` (`:878`, `:886`) — but a Fast Refresh remount of `OnboardingSetupScreen` during development resets `completionStarted` to `false` in a FRESH ref while an OLD in-flight `runCompletionSequence()` closure keeps running (its `cancelled` flag only stops that OLD closure's own subsequent steps — it does not abort `runOnboardingThreadCalibration()`, which has no cancellation token). A dev-only, Fast-Refresh-specific double-invocation is plausible; not reachable in a production build where the component tree only mounts once. |
| `onboardingStartedAt` | `OnboardingSetupScreen.tsx:163` | `OnboardingSetupScreen.tsx:165` (write-once, guarded by `prefs.onboardingStartedAt === null`) | No — this field is explicitly designed to be written at most once per install, and the guard is a value check (not a flag), so a duplicate write attempt is a no-op even if it raced (the `next` computed from a stale `current` would still carry the SAME `startedAt` value in this one case, making this the one field immune to the general lost-update problem by accident of its own idempotent value). |

---

## Fire-and-forget promises in `services/` (no `await`, no `.catch`), ranked by user-visible silent-failure risk

Every `void <expr>` and `void (async () => {...})()` in `services/` was found
and individually checked for whether the underlying async function already
swallows its own errors internally (in which case the missing `.catch` at the
call site is cosmetic, not a real gap) versus one that can actually throw
un-observed.

| Rank (highest risk first) | Call site | Does the failure actually vanish silently? |
|---|---|---|
| 1 | `services/notes/noteManager.ts:173` `void (async () => { const extracted = await extractToDosFromText(text); ... })()` (`scheduleToDoExtraction`) | `extractToDosFromText` itself never throws (its own top-level `try/catch`, `transformationEngine.ts:1015-1085`, swallows everything to `[]`), BUT the `for` loop's own `addToDo()` calls (`noteManager.ts:182-191`) are individually try/caught — so a single extracted to-do failing to save is logged, not lost silently as a *crash*, but the user is never told even one to-do failed to persist from a note they just recorded. Real, user-relevant silent failure, just not a crash. |
| 2 | `services/ai/localLlama.ts:852` `void recordCompletionSpeed(result.timings.predicted_per_second)` | `recordCompletionSpeed` calls `writePreferences`, which calls `FileSystem.writeAsStringAsync` — a real disk write that CAN throw (full disk, permission error). A failure here is silently dropped with no log at all, and — per the state-mutation map above — corrupts the adaptive-tier/thread-escalation decision pipeline's only data source (`getAverageTokensPerSecond`) with no visible symptom beyond "the device never gets offered a tier/thread upgrade it should have qualified for." |
| 3 | `services/notes/noteManager.ts:422` `void (async () => { ... for (const note of missingNotes) { if (await tryEmbedNote(...)) ... } })()` (`mergeMissingNotes`'s background embed pass) | `tryEmbedNote` swallows its own errors and returns `false` (already correct, by design). The `void` wrapper itself can't throw since nothing inside is unhandled — genuinely benign; listed here mainly to document it was checked, not because it's a real gap. |
| 4 | `services/ai/modelDownloadManager.ts:234-237` `void (async () => { await maybeAttemptTierUpgrade(); await maybeAttemptThreadEscalation(); })()` | Both callees have their own internal `try/catch` around the risky download step (`:682-697`) and never throw past their own boundaries in the paths read — genuinely safe, but worth noting this is the SAME call site responsible for the `preferences.ts` overlap race in the findings table, i.e. it's silent-failure-safe but not race-safe. |
| 5 | `services/audio/tts.ts:60`, `services/ai/useChatSession.ts:86/92/171/195` (`void speakText(...)`, `void stopSpeech()`) | Outside this agent's primary scope (Agent 2 owns the audio-source-ownership matrix) — noted only because they appear in `useChatSession.ts`. Not investigated further here to avoid duplicating Agent 2's work. |
| — | `services/ai/enginePrewarmer.ts:33-34` (`void prewarmLocalLlama(); void prewarmLocalWhisper();`) | **Checked and safe** — both functions wrap their own body in `try/catch` with a `console.warn` (`localLlama.ts:1121-1125`, `localWhisper.ts:172-181`). Not a real fire-and-forget gap despite the syntax; excluded from the ranking above. |

---

## Known-safe, checked and fine

- **`processCompletionQueue`'s preemption/retry logic** (`localLlama.ts:780-876`)
  — traced statement-by-statement; the retry re-enqueue cannot race the
  in-flight teardown because `isCompletionRunning` gates it. Generalizes
  correctly to a third concurrent job type (boot warmup, tagged `"background"`
  exactly like extraction) with no special-casing needed.
- **`cancelActiveLlamaCompletion()` cannot produce a double-settle** — a
  `Promise` resolves exactly once; `userCancelled` and `preempted` are checked
  in a fixed, mutually-exclusive order inside the one settle handler that
  ever runs. The only residual risk is the benign ordering edge case listed
  as P3 above, not a correctness bug.
- **A live retrieval read against an in-flight `tryEmbedNote()` write cannot
  produce a torn/dirty read** — confirmed via op-sqlite's own C++
  (`cpp/OPThreadPool.cpp:14`, one worker thread per connection, FIFO). The
  worst case is a stale-but-consistent read (the note simply isn't visible to
  `hybridSearchNotes()` yet), which is already accounted for by the code's own
  `WHERE status = 'embedded'` filter and `retryPendingEmbeddings()` catch-up
  pass.
- **`prewarmEngines()`'s three fire-and-forget calls are genuinely safe** —
  each wrapped function has its own internal `try/catch`; the missing
  `.catch()` at the call site is cosmetic.
- **The `tier3BStatus`/`threadEscalationStatus` "no in-flight flag" design is
  intentional, not a gap** — a kill mid-trial leaves them at `"not_attempted"`,
  which safely triggers a full retry on the next "ready" transition; unlike
  onboarding calibration, there's no product reason here to avoid a repeat
  attempt.
- **The completion queue and `useChatSession`'s in-flight state cannot be left
  "stuck" by a process kill** — see section B(b) above. Neither is persisted
  anywhere; a kill resets both to their initial empty state on the next
  launch, by construction, with no explicit recovery code needed (or present).
- **`onboardingCalibrationAttemptInFlight`'s recovery logic is correct** —
  the one place in this codebase that needed durable, resumable state instead
  of a `try/catch`, and it has it (`modelDownloadManager.ts:842-859`).

---

## Dedicated section: JS-catchable races vs. whole-process native OOM kills

Restating this plainly, per the audit brief's explicit requirement, because
several findings above depend on keeping the two apart:

- **JS-catchable async races** found in this audit: the `preferences.ts`
  lost-update race (section A), the `beginDownloads()` re-entrancy gap, the
  `pipelineStage.ts` cross-flow overwrite, and the cancel-ordering edge case.
  All four are bugs in this app's OWN JS logic — a mutex, a re-entrancy flag,
  or a per-session identity would fix each one, and the process never stops
  running while they happen. A `try/catch` is the right tool for none of
  them specifically (the fix is a lock/guard, not error handling), but they
  are fixable entirely within a live, continuously-running process.
- **The SQLite transaction-isolation finding (P0)** sits in between: it's not
  a JS logic bug in this app's code, but it's also not an OOM kill — it's a
  native-library threading gap (`executeSync` bypassing the worker-thread
  queue `execute()` uses) that manifests while the process is very much
  alive. It needs a JS-level mutex around "is a transaction currently open on
  this connection" — a fixable, in-process concurrency primitive, not a
  durable/resumable design.
- **Whole-process native OOM kill**: confirmed today, this codebase has
  exactly ONE piece of concurrency-relevant state that a kill can leave
  meaningfully "stuck" — `onboardingCalibrationAttemptInFlight` — and it
  already has the durable, on-disk, resumable fix the failure mode actually
  requires (checked on the next launch, not caught by anything at kill time,
  because nothing CAN catch a kill). Everything else audited in this report
  (the completion queue, `useChatSession`'s in-flight refs, `isSendingRef`)
  lives only in process memory and is therefore reset — not stuck — by the
  same kill that would otherwise be feared to leave it stranded. No `try/catch`
  anywhere in `services/ai/localLlama.ts` or `useChatSession.ts` is doing (or
  needs to do) any work to achieve this safety; it is a byproduct of that
  state never being persisted, not a designed OOM-recovery mechanism.
- Practical implication for any future release-on-background fix (Agent 1's
  finding: `releaseLocalLlama()` has no caller today): such a fix is a
  JS-catchable-race concern (must route through `runExclusiveLlamaTask()`,
  section B(a)), NOT an OOM-survival concern — releasing the context
  deliberately, in a live process, is a completely different problem from
  surviving the process being killed out from under an in-flight completion,
  and the two should not be designed against with the same mechanism.
