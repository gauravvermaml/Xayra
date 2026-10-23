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

### Restore: remaining limits after the newer-wins update

Restore now updates records the phone already has: the newest version wins,
only when the phone's EXACT current version (text, and every to-do field it
would overwrite) is in one of the verified backups just read, and is
re-checked inside the write transaction (so nothing is lost); rules and tests in `services/backup/restoreMerge.ts`
and `__tests__/restoreMerge.test.ts`. What it still doesn't do:

- **Deletions aren't carried.** Backups keep no deletions (no tombstones).
  Restore only ever runs when the user taps Restore (Settings or Archive) —
  never automatically, and a backup never writes to the phone — but that
  explicit restore brings back a note or to-do deleted on the phone since
  the backup. Existing behaviour. Fixing it needs deletion records in the
  backup format — a format change, not done.
- **Conflicts are summarised, not reviewable.** A record whose newer version
  can't be established safely keeps the phone's version: a phone change not
  yet backed up, equal timestamps with different content, a backup copy
  without a timestamp (to-dos changed before 2026-10-16, older note backups),
  or two backups holding different versions at the same time. The restore
  message then says "Some existing items were kept because their changes
  couldn't be safely compared." There is no screen to review them.
- **Timestamps are only partly trustworthy.** A backup copy's `updated_at`
  is when it was first copied into a backup, which can be later than the
  edit, and a phone's own `updated_at` also moves on status changes (e.g.
  when indexing finishes). The "phone version must already be backed up"
  rule is what keeps this from ever overwriting an un-backed-up edit. The
  backup-side merge of concurrent heads (`mergeOtherHeadInto`) still uses
  plain newer-wins.
- **Calendar events aren't updated.** A to-do replaced by restore keeps its
  Calendar link, but the Calendar event isn't changed until the to-do is
  sent again.
- **Legacy plaintext backups** (`remi_backup.db`) stay insert-only.

### Grounding limitations (RAG Grounding v1, frozen)

- **Same-note combination:** note-level coverage lets an answer combine two
  sentences of one note and misrelate them ("on his way back from painting
  the fence"). Sentence-level coverage was measured and rejected nine correct
  answers; a fix needs relationship-of-phrase checking, which is new
  grounding work.
- **Documented false rejections:** F17, F9, F13 and U6, plus six incomplete
  or off-topic answers (see `PROJECT_STATE_HANDOFF.md` → "RC1 — Grounding
  v1").
- **Still open after the 2.0 Ask-quality pass** (synthetic set and real
  model: `scripts/eval/runAskQuality.ts`; unit cases: `__tests__/askQuality.test.ts`):
  - **Pronoun misattribution (can be shown):** "Ronnie's house has three
    bedrooms and he wants to repaint the hallway green" passes when the
    hallway is in another person's note — a pronoun statement with no name
    or number isn't tied to any note. Proposed next step: resolve "he"/"she"
    to the single person named in the previous statement of the same answer.
  - **Role inversion (can be shown):** "he has accepted an offer" for a note
    saying Ronnie's offer WAS accepted. The doer check takes the name before
    the verb, which is wrong for passives: "Ronnie promoted Priya" passes
    against "Ronnie was promoted by Priya", and the correct "Priya promoted
    Ronnie" is rejected. Proposed next step: passive-voice awareness (closed
    auxiliary list + "by"), then the pronoun step above.
  - **Plan stated as done (can be shown):** with only a booking note,
    "You went to Byron Bay in the first week of December" is accepted — a
    future date stated in the past tense. Tense and future dates aren't
    checked. (Companions from a plan — "…are coming with me" — are not
    joined, so "You went with Dev and Anika" is rejected.)
  - **General yes/no questions are model-dependent:** "Has Ronnie been
    having issues lately?" is asked in open form ("What do my notes say
    about whether…"), which stopped the model opening with "Yes". With three
    notes in context the answer still often fails validation, correctly — it
    merges facts from two notes into one clause, adds "no other issues are
    mentioned", or moves a date to the wrong fact. The wh-form ("What
    problems has Ronnie had recently?") is reliable.
  - **"Lately" window is fixed at 30 days** (`RECENT_WINDOW_DAYS`); explicit
    dates in the question take precedence. When nothing falls in the window
    the generic no-notes or unverified message appears — a dedicated "nothing
    in the last 30 days" message would be clearer.
  - **Date parsing (pre-existing):** "since September" is read as September
    only, and "the past few months" as July only (`queryDateRange.ts`).
  - Handled in that pass: multi-note summaries; year-less dates must be
    stated; partial answers ("…don't mention how much the cabin cost");
    past-tense accompaniment sentences ("Dev and Anika came with me");
    yes/no questions a "Yes" can't verify are asked in open form; "lately"
    keeps notes from the last 30 days.
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

### Xayra Premium (subscriptions) — follow-ups

Implemented on `feat/premium-subscriptions` (RevenueCat, anonymous
customers; rules in `services/billing/`). Still to do:

- **Real Google Play purchases are untested.** Trial start, renewals,
  cancellation, grace period, account hold, refunds and restore need the
  production package from a Play testing track with licence testers — that
  requires a release-gate exception and an EAS build (not yet authorised).
- **RevenueCat public SDK key** goes in `app.json`
  `extra.revenueCat.androidApiKey` once the RevenueCat project exists. With
  it empty, premium actions open the paywall, which says plans aren't
  available; nothing else is affected.
- **Google Block Store is still included.** Excluding it is crash-safe only
  from purchases-android 10.29.0 (RevenueCat PR #4459); react-native-purchases
  10.15.1 bundles 10.28.1. Revisit when the React Native SDK moves on.
- **Terms of use.** The paywall links the privacy policy only; there is no
  Xayra terms-of-use page yet.
- **Privacy policy and Data safety** drafts are in `docs/premium-privacy-drafts.md`
  (untracked) awaiting approval; nothing is published.
- **Offline limits (by design):** Premium continues offline for at most
  seven days after the last check and never past the known expiry, so a
  weekly or monthly subscriber offline across a renewal date loses Premium
  until the next check; a device clock set more than seven days ahead
  blocks Premium until corrected; a refund made while offline applies at
  the next check.
- **Existing testers** (1.0.x / 2.0.0) keep all their data; their first new
  note or Ask after updating opens the paywall.

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
