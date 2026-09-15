# Phase 3 Execution Brief — Structural Cleanup & Long-Term Test/E2E Infrastructure

> **STATUS: EXECUTED 2026-09-16.** Both open questions were answered by the user ("Ill go with your recommendation" on Maestro — one flow first; "I'm fine leaving these as documented/no-action" on P3-2/P3-4/P3-5). P2-2 and P3-1 shipped; the Agent 4 test backlog (items 1/2/6/7/8/9) closed out with new regression tests, surfacing a second real instance of the Build 41 `stopCompletion()` bug along the way (`cancelActiveLlamaCompletion()`, fixed the same way). Maestro (item 10) was installed and validated per the recommended one-flow approach — result: **not currently usable for unattended E2E**, blocked by a real MIUI input-injection restriction on the test device plus this app's own biometric gate, both found live and documented in full in `qa/05-consolidated-triage.md`'s dedicated write-up (not a Maestro or app bug). See `qa/06-phase-execution-roadmap.md`'s "Status — Phase 3 EXECUTED" section for the full summary. The rest of this document is preserved as originally drafted, for the record.

Built from `qa/05-consolidated-triage.md`'s remaining backlog and `qa/06-phase-execution-roadmap.md`'s roadmap-level scoping, detailed to the same depth as Phase 1 and Phase 2's briefs. **No code has been changed under this document.** All line citations below were re-verified against the current source just now — `localLlama.ts` and `noteManager.ts` both grew during Phases 1-2, so their line numbers have shifted from the original agent reports; corrected here.

## What Phase 3's scope actually is, now that Phase 2 already closed one item

The roadmap's original Phase 3 scope included the dead "Reset" code (`cancelAndRestart`/`restartListening`/`cancelListening`) — that shipped early, during Phase 2, per your explicit "delete the leftover code" decision (`qa/05-consolidated-triage.md`'s P3-3 entry). What's left:

- **One real, still-open P2**: `pipelineStage.ts`'s single global "what's happening" label (P2-2).
- **Four P3s**, three of which the original audit itself already characterized as low-value (see the honesty check below).
- **The remainder of Agent 4's test backlog** (`qa/04-test-strategy-report.md`) not already covered by Phases 1-2: two wake-word regression locks, a single-biometric-prompt test, a cancel-gesture no-trace-left test, a retrieval-relevance-floor boundary test, a completion-queue-ordering test.
- **First Maestro E2E flows** — the one genuinely new infrastructure investment in this phase.

## An honesty check on the P3 items, before proposing to spend any effort on them

Phase 1's SQLite fix and Phase 2's testing-library both taught the same lesson: don't spend effort where the payoff doesn't justify the risk/cost. Applying that here — of the four remaining P3s, only one (P3-1) is worth a code change:

- **P3-1** — a real (if currently harmless) cleanup-wiring bug. Fixing it is a five-line change with no risk. **Proposed: fix it.**
- **P3-2** — dev-only, zero production impact, by the original audit's own words. **Proposed: leave as documented, no code change.**
- **P3-4** — "benign, not a correctness bug," by the original audit's own words. **Proposed: leave as documented, no code change.**
- **P3-5** — "theoretical, no realistic repro for a single-user mobile app," by the original audit's own words. **Proposed: leave as documented, no code change.**

This keeps Phase 3's actual code-change surface small (P2-2 + P3-1), and puts the bulk of the phase's effort where it compounds — the test backlog and Maestro flows — rather than fixing bugs the audit itself already said aren't worth fixing.

---

## 1. Exact issues and files

| # | Issue (from triage) | Files touched | Fix shape |
|---|---|---|---|
| 1 | **P2-2** — `pipelineStage.ts`'s single module-scoped `current: PipelineStage \| null` has no owner/flow identity. A concurrent note-save (`noteManager.ts`) and chat-query (`rag.ts`) both write through the same `setPipelineStage()`, so whichever one calls it last wins — the Home screen's recorder canvas (subscribed via `app/index.tsx:230`) and Chat's streaming-answer row (subscribed via `ChatSheetContent.tsx:45`) can each end up showing the OTHER flow's stage label. | `services/ai/pipelineStage.ts` (whole file, 61 lines), `services/notes/noteManager.ts:137-157` (`setPipelineStage` call sites), `services/ai/rag.ts:169-214` (`setPipelineStage` call sites), `app/index.tsx:229-230` (subscriber), `components/ChatSheetContent.tsx:45` (subscriber) | Give the pub/sub a flow key instead of one shared value: `setPipelineStage(flow: "note" \| "chat", stage: PipelineStage \| null)`, backed by a `Map<Flow, PipelineStage \| null>` instead of one `current`. Each subscriber passes the flow it cares about; `noteManager.ts` always writes `"note"`, `rag.ts` always writes `"chat"`. No behavior change for the common single-flow case — only fixes the concurrent case, which has no known live symptom yet (same "invisible until it isn't" shape as P0-1, at far lower stakes: a wrong label for a few hundred ms, not data loss). |
| 2 | **P3-1** — `OnboardingSetupScreen.tsx`'s escape-hatch timer's `return () => clearTimeout(timer)` (line 178) is the return value of the inner `async` IIFE (`void (async () => {...})()`, started at line 161) — an `async` function's return value that's never awaited or captured is simply discarded, so this cleanup function is never called by React. The *outer* `useEffect`'s actual cleanup (lines 181-184) only sets `unmounted = true` and calls `stopWatching()`; it never touches `timer`. Currently harmless only because the timer's own callback (line 174) re-checks `unmounted` before calling `setShowEscapeHatch`, so a stray fire after unmount just no-ops. | `components/OnboardingSetupScreen.tsx:148-185` | Hoist `timer` to a variable declared in the outer effect's scope (e.g. `let timer: ReturnType<typeof setTimeout> \| undefined;`), assign it inside the IIFE, and clear it in the real cleanup function alongside `stopWatching()`. Five-line change, no behavior change for any currently-observable case — pure hygiene, removing a dangling timer reference rather than fixing a live symptom. |

**Explicitly not touched, per the honesty check above**: P3-2 (Fast-Refresh dev-only native-singleton leak), P3-4 (cancel-tap-vs-natural-completion ordering edge case), P3-5 (no starvation ceiling on repeated preemption) — all three stay documented in `qa/05-consolidated-triage.md` as accepted, no-action findings.

---

## 2. Test infrastructure for Phase 3

No new mocking layer needed for items 1-2 above — both are pure-JS/TS logic, testable with the same renderer-free Jest approach Phase 2 settled on (RNTL stays uninstalled; still confirmed non-functional in this stack).

**New unit tests for items 1-2:**
- `pipelineStage.test.ts` — asserts `setPipelineStage("note", "saving")` and `setPipelineStage("chat", "answering")` called back-to-back leave BOTH flows independently queryable/subscribable (the exact concurrent-overwrite scenario P2-2 describes), and that a listener subscribed to one flow never fires for the other flow's writes.
- `onboardingEscapeHatch.test.ts` (or extending an existing onboarding test file if one exists — none currently does, confirmed via `ls __tests__/`) — a renderer-free test is not viable here since the bug lives inside a component's `useEffect` closure; **this one specifically needs either RNTL (confirmed dead) or a live/manual check**. Proposed: skip an automated test for this item specifically, verify by code review + a single manual reload-during-escape-hatch-window check on-device, and note in the fix's own commit/doc comment why no automated regression lock exists for it (an honest gap, not a silently skipped one).

**Agent 4 test-backlog items being closed out this phase** (numbers per `qa/04-test-strategy-report.md`'s table, current file/line citations re-verified):

| Backlog # | Test | Current citation | Effort |
|---|---|---|---|
| 1 | `containsWakeWord` fuzzy-matches "xayra" within edit distance 2, rejects beyond it | `services/audio/activeMode.ts:161` (`MAX_EDIT_DISTANCE`), `:192-197` (`containsWakeWord`) | S |
| 2 | `stripNonSpeechMarkers` removes `[blank_audio]`/`[silence]`/`(silence)` wherever they occur | `services/ai/localWhisper.ts:32-36` (`NON_SPEECH_MARKER_PATTERN`/`stripNonSpeechMarkers`), applied at `:221` | S |
| 6 | `readOrCreateKey` triggers exactly one biometric prompt per key access, not two | `services/crypto/keyManager.ts:65-70` (single `requireAuthentication: true` gate) | M — mock `expo-secure-store` + `expo-local-authentication` |
| 7 | `cancelActiveLlamaCompletion` rejects with `LlamaCancelledError`, leaves no note/message behind if cancelled before completion | `services/ai/localLlama.ts:718-721` (`LlamaCancelledError`), `:937` (`cancelActiveLlamaCompletion`), settle-order logic `:858-887` | M — needs the mocked-`llama.rn` deferred-promise pattern already proven out in `localLlama-preemption-hardening.test.ts` |
| 8 | `MAX_NOTE_VECTOR_DISTANCE=0.4` excludes the documented false-positive distances (0.501, 0.531), includes a true-positive below the floor | `services/notes/noteManager.ts:684` (`MAX_NOTE_VECTOR_DISTANCE`), doc comment `:670-684` citing the calibration data, filter at `:816` | S — pure numeric boundary test |
| 9 | `processCompletionQueue`: a preempted background job is re-enqueued exactly once, can't be dequeued before the preempting job's teardown finishes | `services/ai/localLlama.ts:810` (`enqueue`), `:830` (`processCompletionQueue`), `:762`/`:831`/`:838`/`:902` (`isCompletionRunning` gate) | M — same deferred-promise mock pattern as item 7 |

Backlog items 3-5 (audio-ownership component checks) are **not** re-attempted here — Phase 2 already substituted live device verification for them after confirming RNTL's incompatibility; re-litigating that tooling choice isn't proposed.

**Maestro E2E (backlog item 10) — flagged for your explicit call before setup work starts**, for the same reason RNTL got a dedicated diagnostic before broader adoption: this is a real new tooling investment (installing the `maestro` CLI, standing up a `.maestro/` directory, writing YAML flows against an installed `.apk`), not a `devDependencies` add. Proposed first flow if you approve: `record-transcribe-save.yaml` (tap record → speak → tap stop → assert a new note card appears) — the single highest-value flow, and the one every other audio/lifecycle fix in this backlog ultimately protects. `ask-and-answer.yaml` and `onboarding-happy-path.yaml` would follow only after the first flow proves the setup actually works reliably on your devices — see the open question below.

---

## 3. Verification criteria for completing Phase 3

- [ ] `npx tsc --noEmit` clean.
- [ ] `npx jest` green, including the new `pipelineStage.test.ts` and the 5 new Agent-4-backlog test files (items 1, 2, 6, 7, 8, 9 above — 6 new files, since item 8 and item 1/2 are each their own small file matching this codebase's existing one-concern-per-test-file pattern).
- [ ] P2-2's fix: manual confirmation that a note save and a chat query running back-to-back on-device each still show their OWN correct stage label (not a spot the original audit could reproduce without deliberately racing the two flows — this is a "confirm no regression," not a "confirm the bug," check).
- [ ] P3-1's fix: code-review confirmation only (per the note in section 2 above — no automated lock for this one, explicitly).
- [ ] If Maestro is approved: the one `record-transcribe-save.yaml` flow runs green against a real installed `.apk` on at least one device.
- [ ] `qa/05-consolidated-triage.md` updated to mark P2-2 and P3-1 closed, and P3-2/P3-4/P3-5 explicitly marked "accepted, no action" rather than left ambiguously open.
- [ ] `PROJECT_STATE_HANDOFF.md` gains a Build 43 section; persistent memory updated; matching the documentation discipline used for Builds 41-42.
- [ ] Explicit sign-off from you before any subsequent phase (there is no Phase 4 currently planned — this would close out the structured QA-stabilization process that started with Build 41, returning to normal feature/fix work afterward unless you want another audit pass at some future point).

---

## Two open questions for you before this can execute

1. **Maestro E2E — start now, or defer?** It's the one item in this phase that's a genuinely new tooling investment rather than more unit tests in an already-working harness. Options: (a) go ahead with just the one `record-transcribe-save` flow to validate the approach works reliably on your devices before investing further, mirroring how Phase 2 diagnosed RNTL with one minimal test before committing; (b) skip Maestro entirely for now and keep relying on Jest + live manual device checks, revisiting E2E later if a specific regression class demands it; (c) do the full 3-flow set proposed in the original audit. My recommendation is (a).
2. **P3-2/P3-4/P3-5 — accept as documented, or do you want any of them fixed anyway?** All three were the original audit's own "no current symptom" / "benign" / "theoretical" calls, not new findings — proposing to leave them as-is and spend the phase's effort on the test backlog and Maestro instead, but flagging it explicitly rather than silently deciding for you.
