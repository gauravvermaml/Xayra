# Xayra — QA Stabilization Plan

**Status: APPROVED (2026-09-15), pending execution.** No code has been changed under this plan. This document is the brief handed to each audit agent during the execution phase — read-only audits only, one Markdown report per agent under `qa/`, followed by a consolidated triage pass before any fix work starts.

## Why this plan exists

Reactive, one-bug-at-a-time fixing on this codebase has been producing new bugs across tester devices as fast as old ones close. Before resuming ad-hoc fixes, this plan runs a structured, read-only audit across four specialized agents, each owning a distinct architectural layer, followed by one prioritized fix backlog.

## Framework note — real architecture vs. a native-Android framing

The original request framed this in native-Android terms (ViewModels, StateFlow/LiveData, RxJava/Coroutines, Espresso). This app is **React Native + Expo**, confirmed by direct inspection, not assumption:

- No ViewModels, no StateFlow/LiveData, no RxJava, no Coroutines anywhere in the app layer. State lives in React hooks (`useState`/`useRef`/`useEffect`) per screen, plus module-scoped singletons in `services/` (a `globalThis`-cached DB connection, a `preferences.json` in-memory cache, native `llama.rn`/`whisper.rn`/`Speech` engine singletons).
- The only Kotlin is three thin Expo native modules (`modules/app-signature`, `modules/device-cpu`, `modules/download-bridge`) — synchronous wrappers, no coroutines in any of them.
- **Zero automated tests exist today** — no Jest, no Detox, no Espresso, no test files at all (confirmed by search).
- Espresso doesn't apply (it drives native Android View hierarchies); the real equivalent for E2E here is Detox or Maestro.

Every agent brief below is remapped onto what actually exists in this codebase, keeping the original 4-way split and intent intact.

## Diagnosis: why this is whack-a-mole, structurally

1. **No regression safety net.** Zero tests means every fix is verified once, by hand, on whichever device is on the desk that day, then never re-checked.
2. **Module-scoped singleton state with inconsistent survival boundaries.** `db/client.ts` caches on `globalThis` specifically to survive Fast Refresh; `preferences.ts` caches in a module-level `let`; the llama/whisper native contexts are process-lifetime singletons. Each has a different survival boundary, and nothing enforces that callers know which.
3. **A history of multi-bug root-cause chains, not single bugs.** The wake-word investigation alone found five independent bugs behind one visible symptom — closing one cause looks like "the fix" until the next cause surfaces on a different device.
4. **Device-dependent failure modes already proven real**: the Pixel 9's LMKD-driven onboarding kill only appeared under real multi-app memory pressure; the Redmi's 2.4GHz Wi-Fi turned a ~15min download into 2.5 hours; MIUI silently drops notification updates that stock Android doesn't.

## Ground rules for all four agents

- **This phase is audit-only.** No edits to `services/`, `components/`, `app/`, or `modules/` source. The only artifacts produced are the reports themselves, under `qa/`.
- **Severity taxonomy**, used consistently across all four reports:
  - **P0** — Crash/hang/data-loss, reproducible or plausible from code inspection.
  - **P1** — Wrong behavior a user would notice.
  - **P2** — Device/condition-specific degradation.
  - **P3** — Structural risk / no current symptom.
- **Every finding cites a real `file:line`**, and links to a prior bug in `PROJECT_STATE_HANDOFF.md`/memory it resembles or could resurrect, where one exists.
- **Cross-cutting findings are flagged, not duplicated** — see the ownership map in each agent's overlap note below.
- **Deliverable format**: a findings table (Severity | File:Line | Scenario | Why it breaks | Repro/verification method) + narrative for anything needing more than one row + an explicit "known-safe, checked and fine" list.

---

## Agent 1 — App Lifecycle & State Agent

*(remapped from "Android Lifecycle & State" — real equivalents here are React component lifecycle, Expo Router navigation state, `AppState` transitions, and the module-scoped singletons standing in for what a ViewModel would own natively)*

**Audits:**
- `app/_layout.tsx` — root layout, the `setupComplete` gate, splash-to-app hand-off.
- `app/index.tsx`, `app/archive.tsx`, `app/settings.tsx` — every `useEffect`/`useFocusEffect` and its cleanup function.
- `components/OnboardingSetupScreen.tsx` — the Build 40 memory-pressure listeners and escape-hatch timer (self-audit of the newest state-lifecycle surface).
- Singleton/cache lifetime boundaries: `db/client.ts` (`globalThis` cache), `services/settings/preferences.ts` (module-level cache), `services/settings/appSettings.ts` (SQLite-backed flag), `services/ai/localLlama.ts` / `localWhisper.ts` (native context singletons) — where each one's lifetime boundary actually is, and whether every caller's assumption matches it.
- `AppState` usage (currently **none**, confirmed by search) across `services/audio/recorder.ts`, `player.ts`, `tts.ts`, the handsfree/wake-word mic session, and any active `llama.rn` completion.
- Android manifest / `app.json` config: screen orientation lock, `android:configChanges`.

**★ New — Native C++ Heap & OOM Allocation Checks** (added 2026-09-15, high risk):
- `llama.rn`/`whisper.rn` allocate on the native C++ heap, entirely outside the JS garbage collector and outside JS `try/catch` — a native OOM kill bypasses JS-level error handling completely, which is a fundamentally different failure mode from anything a `try/catch` audit would catch.
- **Confirmed gap to start from**: `releaseLocalLlama()` exists (`services/ai/localLlama.ts:1134`) but has **zero call sites triggered by backgrounding** — no `AppState` listener anywhere in the app calls it. The native context (and its full KV-cache allocation) stays resident on the C++ heap for the app's entire backgrounded lifetime.
- Audit whether this is the actual mechanism behind the already-documented LMKD onboarding kill (Build 40) — a backgrounded Xayra holding a multi-hundred-MB native context is exactly the kind of resident footprint LMKD scores against when deciding what to reap, independent of whatever JS-visible `ActivityManager.MemoryInfo` reading `memoryGuard.ts` sees at the moment it checks.
- Same question for `whisper.rn`'s context — does it have an equivalent release function, and is it any better wired?
- If a release-on-background policy is later proposed as a fix, audit the cost side too: does releasing mid-onboarding-download or mid-active-recording break anything already in flight (this is a finding to report, not a fix to implement now).
- Check whether a native OOM kill during an active `llama.rn` completion leaves any on-disk or in-memory JS state inconsistent (e.g., `useChatSession.ts` believing a completion is still in flight after the process that would resolve it no longer exists).

**★ New — SQLite Transaction Safety** (added 2026-09-15, high risk):
- Audit every `op-sqlite` write path for atomicity across a process kill, specifically comparing the transactional writes that already exist correctly (`services/notes/noteManager.ts:336` `deleteNote()`, `services/todos/todoManager.ts:480`, both using `db.transaction()`) against writes that don't.
- **Confirmed gap to start from**: `tryEmbedNote()` (`services/notes/noteManager.ts:135`) calls `insertEmbedding(id, embedding)` then `updateNoteStatus(id, "embedded")` as two separate, un-transacted statements. A kill between them leaves a `note_embeddings` row with `notes.status` still `"transcribed"` — orphaned from `hybridSearchNotes()`'s `WHERE status = 'embedded'` filter. Audit whether `retryPendingEmbeddings` (referenced in `noteManager.ts`'s comments) would then attempt to re-embed this note, and whether `insertEmbedding` handles being called a second time for the same note without producing a duplicate/conflicting `note_embeddings` row (the table has no explicit primary key, relies on `rowid` joined against `notes.rowid`).
- Same question for the `notes_fts` external-content triggers (`db/schema.ts:170-180`) — since FTS5 external-content sync depends on triggers firing off the `notes` table, confirm a kill mid-write can't leave `notes_fts` referencing a `rowid` that `note_embeddings` or `notes` itself no longer agrees on.
- Audit the to-do extraction write path (`transformationEngine.ts` → wherever it lands in `todoManager.ts`) for the same class of gap — is the extracted to-do write, and any note-status update marking extraction complete, wrapped in one transaction or two independent ones?
- Confirm SQLCipher's own write-ahead-log/rollback-journal mode is configured in a way that guarantees a killed-mid-write transaction actually rolls back cleanly on next open (this is a `db/client.ts` connection-configuration check, not just an application-code check).

**Hunts for (original scope, unchanged):**
- A `useEffect` with no cleanup, or a cleanup firing on the wrong dependency array (stale closure) — this class of bug already happened once (the `useFocusEffect` + `recorderRef` pattern was added specifically to dodge it; confirm no other screen has the naive version).
- What happens if the app backgrounds (home button, recent-apps swipe, incoming call) while: recording a note, mid-RAG-generation, mid-onboarding-download, mid-to-do-extraction.
- Re-entrancy: can the user navigate away and back fast enough to double-invoke a `useFocusEffect` mount, given singletons that only support one active caller?
- Disagreement between the three persistence/cache strategies (`globalThis` DB cache, `preferences.ts` module cache, `appSettings.ts` SQLite flag) under a Fast-Refresh-vs-real-restart mismatch.
- The onboarding escape-hatch timer and memory-pressure `useEffect` in `OnboardingSetupScreen.tsx` — correct cleanup on unmount; behavior under a device clock change or a Drive-restored `preferences.json` on a second device.
- Every `<Modal>` immediately followed by `router.push`/`router.replace` — this combination has already caused a dead-touch-input bug twice (Quiet Corner overhaul, TodosOverlay); hunt for any remaining uncaught instance.

**Deliverables:**
- `qa/01-lifecycle-state-report.md` — findings table.
- A singleton lifetime map: every module-scoped singleton, its actual survival boundary, every call site that reads/writes it.
- A background/foreground transition matrix: rows = {recording, RAG query, extraction, onboarding download, handsfree listening}, columns = {home button, recent-apps swipe, incoming call, screen lock}.
- A dedicated sub-section on native heap lifecycle: does anything release `llama.rn`/`whisper.rn` context on backgrounding today (expected answer: no), and a concrete, named recommendation (not yet implemented) for where an `AppState` listener would need to live.
- A dedicated sub-section on transaction boundaries: a table of every multi-statement write path in `services/`, whether it's wrapped in `db.transaction()`, and the concrete consequence of a kill between its statements if not.

---

## Agent 2 — Audio & Voice Engine Agent

**Audits:**
- `services/audio/recorder.ts`, `player.ts`, `tts.ts`, `activeMode.ts`, `wav.ts` — the entire audio-source-ownership layer.
- `services/ai/localWhisper.ts`, `services/ai/asrRouter.ts` — transcription engine and device-tier routing.
- The handsfree wake-word native mic session (subject of a 5-bug root-cause chain already closed — this agent's job is to confirm none of those 5 have regressed and hunt for a 6th).
- Every call site of `stopSpeech()`, `playUri()`, and the recorder's start/stop, cross-referenced against the documented "single active audio source app-wide" invariant.
- Android audio focus handling — whether the audio config requests focus correctly and releases it, and what happens when another app takes focus away mid-recording or mid-TTS.

**Hunts for:**
- Two audio sources active simultaneously despite the "single active source" rule — enumerate every entry point that can start a recording (button tap, wake-word trigger, a to-do reminder read-aloud if any) and confirm each calls `stopSpeech()` first, not just the already-known ones.
- What the wake-word mic session does when a phone call arrives mid-listening — a real audio-focus preemption scenario distinct from the app-level cases the wake-word bug chain already fixed.
- Whisper transcription competing for the mic with a simultaneous wake-word listening session.
- The Whisper/Llama CPU-contention gate (`transformationEngine.ts`'s transcription-idle wait, and boot-warmup's `waitForTranscriptionIdleBeforeWarmup`) — confirm it gates on every extraction trigger path, and that the bounded-retry warmup can't barge in under load.
- Recording interrupted by a low-battery/low-storage dialog, or by the OS revoking mic permission mid-session — fails loud and recoverable, or hangs/silently produces an empty note?
- `services/notifications/todoNotifications.ts`'s tap-to-open flow colliding with an already-active audio source.
- Bluetooth/wired headset connect or disconnect mid-recording or mid-playback.

**Deliverables:**
- `qa/02-audio-engine-report.md` — findings table.
- An audio-source ownership matrix: every code path that can start {recording, TTS, note playback, wake-word listening} vs. confirmation it stops every other active source first.
- A named regression check against each of the 5 previously-fixed wake-word bugs, plus any new candidate found.

---

## Agent 3 — Asynchronous & Concurrency Agent

*(remapped from Coroutines/RxJava — real concurrency primitives here are Promises/async-await, the `llama.rn` completion priority queue, and mutable module-scoped state read/written from multiple async call sites)*

**Audits:**
- `services/ai/localLlama.ts` — the completion priority queue (`interactive`/`background`), `stopCompletion()`-based preemption, `cancelActiveLlamaCompletion()`, the cache-warmup gate.
- `services/ai/transformationEngine.ts` — the to-do extraction pipeline and its GBNF-grammar completion.
- `services/ai/modelDownloadManager.ts` — onboarding calibration (`runOnboardingThreadCalibration`, `onboardingCalibrationAttemptInFlight`), tier-upgrade trial, thread-escalation trial — all reading/writing shared `preferences.ts` state from potentially overlapping async flows.
- `services/ai/useChatSession.ts` — `runRagExchange`'s cancellation handling and message-list mutation.
- `services/ai/memoryGuard.ts` and its two call sites in `OnboardingSetupScreen.tsx`.
- Every `await` in a `services/` function immediately followed by a read of shared module state.

**★ New — Native C++ Heap & OOM Allocation Checks** (added 2026-09-15, high risk, shared brief with Agent 1):
- Where Agent 1 maps *whether* native context release is wired to backgrounding, Agent 3 audits the **concurrency correctness** of that boundary: if a release-on-background path is added later, can it race against an in-flight completion request already queued or executing? Map every point where JS code assumes the native context is alive (queue dispatch, `stopCompletion()`, any direct completion call) and flag each as a future race if release-on-background lands without a corresponding "is the context currently in use" guard.
- Audit what currently happens, today, if the native process is OOM-killed mid-completion: does any JS-side state (the completion queue, `useChatSession.ts`'s in-flight message, `onboardingCalibrationAttemptInFlight`) get left permanently "in flight" with nothing left alive to ever resolve or clear it, since a native OOM kill takes the whole process — JS included — not just the native heap? (This reframes the risk correctly: a native OOM kill is a whole-process kill, not a catchable native-only exception — confirm the audit report states this distinction explicitly rather than implying JS `try/catch` could ever intercept it.)

**★ New — SQLite Transaction Safety** (added 2026-09-15, high risk, shared brief with Agent 1):
- Where Agent 1 maps *which* write paths lack transaction wrapping, Agent 3 audits **concurrent access** to those same paths: can a live RAG query's retrieval read (`hybridSearchNotes()`) run concurrently with an in-progress, not-yet-committed `tryEmbedNote()` write for a note just recorded seconds earlier? `op-sqlite`/SQLCipher's own concurrency model (journal mode, reader/writer locking) determines whether that's a safe blocking read, a stale read, or a lock contention error surfaced to the user — audit which, and whether any call site actually handles a lock-contention error if the underlying SQLite journal mode allows one to occur.
- Audit whether the to-do extraction pipeline (`transformationEngine.ts`) and a live RAG query can attempt overlapping writes/reads against the same note row, and whether the existing completion-queue priority mechanism (interactive vs. background) has any awareness of *database* contention as opposed to just *CPU/model* contention — these are two separate resources this app currently only arbitrates one of.

**Hunts for (original scope, unchanged):**
- Two async operations racing to write the same `preferences.ts` field — specifically whether `onboardingCalibrationAttemptInFlight` can be hit by a *concurrent* race (two calibrations starting close together) as opposed to just the *retry-after-kill* race it was designed for.
- Whether the Build 36 fix (a live query waiting behind an already-running background extraction) generalizes to a third concurrent job type (boot warmup + extraction + a live query all landing within the same second).
- `cancelActiveLlamaCompletion()` racing the completion's own natural finish — does "cancelled AND completed" resolve deterministically, or can both handlers fire?
- Whether the known, accepted Build 39 gap (a sub-second window between "transcript obtained" and "note actually written" isn't cancel-guarded) has widened, and whether the same class of gap exists in to-do extraction.
- Fire-and-forget promises anywhere in `services/` (no `await`, no `.catch`).
- Whether any long native JNI call is ever awaited in a way that blocks the JS thread from processing a cancel/background signal meant to interrupt it.

**Deliverables:**
- `qa/03-concurrency-report.md` — findings table.
- A state-mutation map for every `preferences.ts` field: every reader, every writer, whether any two writers can legitimately overlap.
- A list of every fire-and-forget (un-awaited, uncaught) promise found in `services/`, ranked by how user-visible a silent failure there would be.
- A dedicated sub-section explicitly distinguishing "JS-catchable async race" from "whole-process native OOM kill" — the latter needs a design that survives a process no longer existing (durable on-disk state, resumability on next launch), not a `try/catch`, and the report should say so plainly rather than blur the two.

---

## Agent 4 — Test Automation Agent

**Audits:**
- The complete absence of test infrastructure (confirmed: no Jest, no Detox, no test files, nothing in `package.json`) — first job is a tooling recommendation, not just gap-listing.
- Every `services/` module as a unit-test candidate (`noteManager.ts`'s `toFtsQuery`/relevance filtering, `todoManager.ts`'s recurrence math, `greeting.ts`, `pipelineStage.ts`).
- Every cross-service integration point as an integration-test candidate (retrieval → prompt-build → completion; onboarding download → calibration → completion-gate).
- Every user-facing flow with real device-hardware dependency as an E2E/device-test candidate (record → transcribe → save; ask → answer; onboarding start → finish; wake-word → auto-record).

**Hunts for / determines:**
- Which of Agents 1-3's P0/P1 findings are regression-testable at all without real hardware (a pure logic bug is trivially unit-testable; an LMKD-class OS kill is not — that needs a documented manual device-matrix checklist, not a fictional automated test).
- The right tool per layer: **Jest** (via `jest-expo`) for `services/` pure logic; **Jest + mocked native modules** for anything touching `llama.rn`/`whisper.rn`/`op-sqlite`/`expo-local-authentication`; **React Native Testing Library** for component-level behavior; **Detox or Maestro** (not Espresso) for true on-device E2E — explicit recommendation between the two, not just a list.
- A prioritized "regression net" list: the 5-10 highest-value tests to write first, chosen to lock in behavior that's already broken once (wake-word detection rate, the double-biometric-prompt fix, the cancel-gesture no-trace-left behavior, the retrieval relevance floor, the completion-queue preemption) — plus, given the two new additions above, a specific recommendation on how (or whether) the native-heap-release and transaction-atomicity findings can be regression-tested at all, versus needing to stay a manual/documented check permanently.
- A device-matrix recommendation for what can never be fully automated (memory-pressure kills, MIUI-specific notification throttling, Wi-Fi-speed-dependent downloads) — naming the real devices already in play (Pixel 9, Redmi Note 8 Pro, Galaxy A50).

**Deliverables:**
- `qa/04-test-strategy-report.md` — tooling recommendation + setup steps (proposed, not installed, during this audit phase).
- A prioritized test backlog (test name → what it locks in → which prior bug it prevents recurrence of → effort estimate).
- A manual device-smoke-test checklist for the categories that can't be automated.

---

## Sequencing & mechanics for the execution phase

- Agents 1-3 run in parallel (read-only, no write conflicts). Agent 4 runs after seeing at least a draft of 1-3's findings, since its backlog is only meaningful once it knows what needs locking in.
- Each runs as a separate read-only subagent task, handed only its own section of this document as its brief, producing its Markdown report under `qa/` as its sole output.
- A consolidated triage pass follows across all four reports, deduplicating the flagged overlaps (native-heap-release and SQLite-atomicity appear in both Agent 1 and Agent 3's briefs by design — Agent 1 owns "where/whether," Agent 3 owns "is it race-safe" — the triage pass merges these into one entry per underlying issue, not two).
- Output of triage: one prioritized backlog (P0 → P3), reviewed with the user before any fix work starts.
