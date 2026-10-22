# Xayra — Backlog

Open work, known limitations and unprioritised ideas. History lives
elsewhere: [CHANGELOG.md](CHANGELOG.md) (by version),
[PROJECT_STATE_HANDOFF.md](PROJECT_STATE_HANDOFF.md) (build log, including an
appendix with the completed items formerly kept here) and Git history.

Last audited: 22 October 2026, against `main` at 6f3356a.

Code comments that cite a BACKLOG.md entry by name (for example "Push
to-dos to Google Calendar") refer to entries now kept verbatim in that
appendix.

## Current release status

- **Xayra 2.0.0 (versionCode 52)** was built by EAS (`4cd4b829`) from commit
  8373c01, tagged `v2.0.0-52`. Its source is merged into `main`.
- Distribution: **Google Play Internal Testing only.** Xayra isn't publicly
  released.
- `release-gate.json` keeps production blocked, with two open blockers (see
  [Security, privacy and compliance](#security-privacy-and-compliance)).
- There is no approved roadmap after 2.0. The ordered roadmap locked on
  2026-10-11 for 1.0.41 is retired: its first two steps shipped, and the
  remaining ideas are listed under [Product ideas](#product-ideas--not-approved)
  without an order.

Product constraint that still applies: **no Ask while the phone is locked**
— Xayra never answers from private notes on the lock screen.

## Open — bugs, correctness and data integrity

### Restore doesn't update an older local copy

- **What:** restoring from Drive only inserts notes and to-dos that are
  missing on the phone (`mergeMissingNotes`, `mergeMissingToDos`). A phone
  that already holds an older copy of an edited note or changed to-do keeps
  the older copy.
- **Why it matters:** after a restore, edits made on another phone can
  silently fail to appear.
- **Evidence:** backups merge newer-edit-wins (`backupDb.ts`), but the local
  restore path is insert-only.
- **Done when:** restore applies a strictly newer `updated_at` to existing
  local rows (notes re-embedded), never deletes, and is covered by tests.

### To-dos changed before `updated_at` existed

- **What:** to-dos changed before release stabilisation (2026-10-16) have no
  timestamp. When two phones' copies differ, the merge can't tell which is
  newer: a backup keeps the backing-up phone's copy; merging or restoring
  concurrent backups keeps the newest backup's copy.
- **Why it matters:** a stale copy can win for those rows only.
- **Status:** known limitation. Any later change stamps the row and resolves
  it. No fix planned.

### Grounding limitations (RAG Grounding v1, frozen)

- **Same-note combination:** note-level coverage lets an answer combine two
  sentences of one note and misrelate them ("on his way back from painting
  the fence"). Sentence-level coverage was measured and rejected nine correct
  answers; a fix needs relationship-of-phrase checking, which is new
  grounding work.
- **Documented false rejections:** F17, F9, F13 and U6, plus six incomplete
  or off-topic answers (see `PROJECT_STATE_HANDOFF.md` → "RC1 — Grounding
  v1").
- **Found in the 2.0 Ask-quality pass** (synthetic set:
  `scripts/eval/runAskQuality.ts`), documented rather than fixed because
  each needs coreference — knowing who "he", "we" or "with me" refers to:
  - **Pronoun misattribution (shown):** "Ronnie's house has three bedrooms
    and he wants to repaint the hallway green" passes when the hallway is in
    another person's note — a pronoun statement with no name or number isn't
    tied to any note.
  - **Companions in another sentence (withheld):** "Booked the Queenstown
    ski trip… Dev and Anika are coming with me" can't answer "Who did I go
    skiing with?"; relaxing this would also accept unrelated people from the
    same note.
  - **"Yes" to a general question (withheld):** "Has Ronnie been having
    issues lately?" — the notes never say "issues", so a "Yes" is never
    shown. The wh-form ("What problems has Ronnie had recently?") works.
  - **"Lately" / "recently" aren't dated:** these words don't narrow
    retrieval to recent notes, so an older note can be presented as recent.
- **Constraint:** Grounding v1 is frozen. Change it only for an identified
  release-blocking failure. Validators validate and never rewrite; an
  unsupported answer is withheld, never fabricated or turned into "No".

## Open — performance and reliability

### Hermes / GWP-ASan native crash on ARM64 (unverified)

- **What:** facebook/hermes#2225 — a SIGSEGV in GWP-ASan's backtrace walker
  during a Hermes compiler fiber. Seen on the x86_64 Android 14 emulator
  (about 1 in 50 launches at defaults).
- **Why it matters:** if it reproduces on ARM64 Android 14+ phones (the
  production target class), it is a launch crash.
- **Evidence:** the Redmi (Android 11) isn't exposed. ARM64 Android 14+ is
  untested. Hermes/GWP-ASan settings are deliberately unchanged.
- **Next:** a scripted cold-launch run on a Pixel 9 (for example Android
  Device Streaming), synthetic data only.

### Whisper transcription latency

- **What:** capture end → transcript took 4.1–8.4 s on the Redmi in 1.0.42,
  the longest part of a warm voice Ask.
- **Next:** measure on Pixel-class hardware first (Redmi numbers are
  stress-test evidence, not the production bar). Options: start loading
  Whisper while the user is still speaking.

### Native model reload after backgrounding

- **What:** Whisper and Llama contexts are released whenever the app goes
  to the background (`useReleaseNativeContextsOnBackground`,
  `app/_layout.tsx`). A voice Ask after returning paid about 4–9 s of extra
  Whisper readiness and about 5 s of Llama reload on the Redmi.
- **Next:** measure whether every short background transition needs a
  release, a grace period before releasing, and preloading at recording
  start — weighed against memory pressure (the Build 40 LMKD kill,
  `memoryGuard.ts`).

### Ask progress timing on a Pixel 9

- **What:** Ask progress thresholds (2.5 s transcription, 3 s / 8 s
  inference phrases in `pipelineStage.ts`) were set from Redmi measurements.
- **Next:** capture `[AskTiming]` / `[VoiceAskTiming]` on a Pixel 9 Xayra Dev
  build; retune the constants only if needed.

### Calendar swipe flicker

- A minor flicker or lag remains on some devices after the page-carousel
  rewrite (Build 52). Parked; re-check on a Pixel 9.

### Model server returns 500 for an out-of-range request

- The model server returns HTTP 500 instead of 416 for a byte range past the
  end of a file (seen 2026-10-22). The app doesn't make such requests, so
  there's no user impact. Low priority.

## Security, privacy and compliance

### Release gate blockers (production stays blocked)

1. **Physical-device confirmation** of the release-batch-1 fixes verified on
   the emulator: the first-launch notification prompt no longer cancels the
   fingerprint; plain error messages; Drive and Calendar consent requested
   separately (the consent loop fix — sign-in is identity-only and Calendar
   is added with `addScopes`); "Recover my notes" reachable in the
   production package.
2. **Privacy policy, Play listing, in-app wording and Data safety** corrected
   for the encrypted release. Drafts await approval; nothing more is
   published until approved.

A third blocker (keyboard / consecutive typed notes) is recorded as
satisfied (Redmi, a3de837).

### Production-package OAuth client on the public debug key

- **What:** an Android OAuth client was registered on 2026-09-30 for
  `com.anonymous.silentconfidant` with the public React Native debug key
  (SHA-1 `5E:8F:16…F6:25`) to work around a `DEVELOPER_ERROR` in a debug
  build.
- **Why it matters:** anyone can sign an app as Xayra with that public key
  and obtain Google tokens for Xayra's project, including its hidden Drive
  folder, if a user consents.
- **Status:** OPEN until its removal is confirmed in the Google Cloud
  Console. Removing it doesn't affect Play builds, Xayra Test or Xayra Dev.
  Keep `android/app/debug.keystore` (Xayra Dev signing).

### In-app third-party notices

- Licence notices for the downloaded models are published next to the
  models and in `licenses/`. An in-app notices screen is a later app change.

### Backup housekeeping (post-release)

- **What:** interrupted backups and Extra Privacy activations leave
  unreferenced files in the hidden Drive folder (unverified generations, a
  generation without a manifest, unused `xayra2-xkeyring-*` files, device
  entries under abandoned keys). They are small and never used for a
  restore.
- **Constraint:** a cleanup must never touch a verified generation, the
  active key wrapper, a device entry in use, or anything another phone may be
  uploading; only leftovers older than a safe age, explicitly or very
  conservatively.

### Legacy linked audio

- Notes saved before text-only storage may still link to WAVs in
  `documentDirectory/recordings/`, kept on purpose (launch cleanup never
  removes linked audio). Proposal: an explicit, user-confirmed "remove old
  recordings" option.

## Evaluation

- The eval harness double-wrapping bug is fixed (see Completed). Two
  follow-ups remain:
  - The fine-tuned model scores 93/103 (90.3%) on the corrected harness
    versus the recorded 94.2%; the gap isn't attributed between the harness
    fix and later extraction changes.
  - With the Build 50 explicit-intent gate, 82 of the full corpus's 91
    extraction notes never reach the model. The corpus needs trigger-bearing
    variants to measure the current pipeline.

## Product ideas — not approved

None of these is scheduled or ordered. Each needs the maintainer's approval
before work starts.

- **Quick Settings tile and lock-screen Record** — "wake phone → tile →
  speak". Record only while locked: no Ask, no browsing, no note content on
  the lock screen. Open question: writing to the encrypted vault while the
  biometric-gated key is unavailable (for example, hold the capture
  encrypted and index it after unlock). It was roadmap item 3 before 2.0;
  needs re-confirmation.
- **Share to Xayra** — receive text from Android's share sheet into the
  compose field. Needs an `ACTION_SEND` intent filter (config plugin or a
  provenance-checked package), a native rebuild, and decisions on cold
  launch and Record/Ask mode.
- **Other capture channels** — headset/earbud invocation;
  VoiceInteractionService only as later research (default-assistant
  requirement, setup burden, Play policy).
- **Personal memory layer** — entity timeline (people, organisations,
  places), event extraction, chronological retrieval, identity resolution
  and longitudinal questions. Every derived fact must point back to its
  source note, and names are never fuzzy-matched in grounding. This would be
  new reasoning work under the Grounding v1 freeze.
- **Subscriptions** and **launch/retention measurement** — listed on the old
  roadmap. Measurement needs a privacy design first: Xayra currently claims
  no analytics.

## Needs verification

- **Tray scrolling at 50%** — reported 2026-10-09: light vertical drags
  sometimes moved the tray instead of scrolling. A dev-only diagnostic saw
  21 of 21 drags with the sheet extended and scrolling unlocked, and the list
  scrolled. 2.0 still uses the same tray (`HistorySheet.tsx`). Reopen only
  with evidence: re-add the logging in `useExpandOverdragGestureHandlers.ts`
  `handleOnStart` (a module-level function via `runOnJS`; Worklets rejects
  `runOnJS(console.log)`), reproduce on Xayra Dev and read the failing drag.

## Completed or superseded

Verified against the current code. Details are in `PROJECT_STATE_HANDOFF.md`
(see its appendix) and [CHANGELOG.md](CHANGELOG.md).

| Item | Evidence |
|---|---|
| Eval harness double-wrapped prompts | `scripts/eval/llamaRunner.ts` uses `llama-completion -no-cnv`; `__tests__/evalHarness-promptOnce.test.ts` |
| Calendar consent loop | Identity-only sign-in (`scopes: []`), Calendar via `addScopes`; physical check is gate blocker 1 |
| Input tray hidden after a send | Gate blocker satisfied (Redmi PASS, a3de837); `__tests__/composeDoubleTap.test.tsx` |
| RAG retrieval and grounding overhaul (Build 56) | `services/ai/queryDateRange.ts`, `temporalResolver.ts`; temperature 0 |
| Tray expand-gesture asymmetry (Build 57) | `SNAP_VELOCITY_WEIGHT` in `useExpandOverdragGestureHandlers.ts` |
| Push to-dos to Google Calendar (Build 53) | `services/sync/calendarSync.ts` |
| Month overflow tap, Week day sheet (Build 55) | `components/calendar/` |
| Rolling-history waveform (Build 52) | `components/CentralRecorderCanvas.tsx` |
| Calendar continuous swipe, grid render cost (Build 52) | Page carousel in `components/calendar/`; flicker is open above |
| Notes tray frozen until a note was opened | Tray list always mounted (`HistorySheet.tsx`) |
| Schedule view scrolling, "Today" pill position | `ScheduleLayout.tsx` (gesture-handler `FlatList`), `CalendarDateNavigator.tsx` |
| Multiline compose field | `ComposeBar.tsx` (5 lines, then scrolls) |
| 1.0.40–1.0.43 releases, 2.0.0 | CHANGELOG.md |
| Roadmap locked 2026-10-11 | Superseded: 1.0.41 shipped, then 2.0.0; ideas listed above unordered |
