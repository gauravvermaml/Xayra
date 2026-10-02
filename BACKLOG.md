# Xayra — Backlog

Parked ideas and feature requests that aren't scheduled into a build yet.
Not a bug tracker (see `PROJECT_STATE_HANDOFF.md`'s build-by-build history
for shipped/known-gap items) — this is for things explicitly deferred to
"pick up later." Strike an item (move it under `## Done`, or just delete it
if there's nothing worth keeping) when it ships.

## Open

### Share-to-Xayra from other apps (Android share sheet)

Let a user share text from any other app (Google Notes, browser, etc. —
wherever Android's own share sheet is available) directly into Xayra's
"Type your thoughts" compose field, the same way sharing into any other
app on the list already works.

**Why parked, not just implemented**: bigger than a normal fix pass —
needs a native `ACTION_SEND`/`text/plain` intent-filter declared in the
Android manifest (an `app.json` config plugin, or the community package
`expo-share-intent`, which is purpose-built for this), a native rebuild
(`expo prebuild --clean` + `expo run:android`, per CLAUDE.md's native-
dependency rules), and JS-side routing of the incoming shared text into
the compose flow. Also a new dependency decision if a package is used —
verify provenance first per CLAUDE.md's own "twice bitten" rule
(`react-native-llama`/`react-native-whisper` history).

**Open questions to resolve when picked up**: cold-launch-via-share (app
not already running) vs. share while already open; whether shared text
should also require a Record/Ask mode choice or default to one; whether
this should also accept `ACTION_SEND` for non-text mime types later
(images, audio) or stay text-only for now.

Raised 2026-09-24.

### Eval harness double-wraps prompts in a second chat turn (`llama-cli -st`)

`scripts/eval/llamaRunner.ts` runs the desktop `llama-cli` with `-st`. In
the installed llama.cpp build (winget `ggml.llamacpp`), `llama-cli` is
conversation-only: it treats the prompt file as a USER MESSAGE and applies
the model's own chat template around it. But every prompt this app builds
(`buildPrompt` in ragPrompt.ts, extraction's `buildPrompt`) is already a
complete ChatML string — so the harness actually sends system/user/
assistant turns nested inside another user turn. Observed directly
2026-10-02: the run printed llama-cli's interactive banner and echoed
`> <|im_start|>system…` before answering.

**Impact**: Tier 2 eval scores (including the 94.2% extraction figure in
`PROJECT_STATE_HANDOFF.md`) may have been measured on doubly-wrapped
prompts the app never sends — not necessarily wrong, but not a faithful
reproduction of on-device input.

**FIXED 2026-10-02 (RC1 — Grounding v1):** the runner now uses
`llama-completion -no-cnv -bf` — raw completion, prompt read byte-for-byte
(`-f` turned out to strip the trailing newline every app prompt ends with,
a second, smaller mismatch). Every eval run first proves the prompt reached
the model exactly once (`verifyPromptPassedOnce`: tokenizer count ==
tokens llama.cpp evaluated); the old path fed 28 extra template tokens per
case. `__tests__/evalHarness-promptOnce.test.ts` pins the argument
contract. Re-measured on the corrected harness: the fine-tuned model
scores 93/103 (90.3%) on corpus-full.jsonl with `--no-trigger-gate`, not
the recorded 94.2% — the gap is not yet attributed between the harness fix
and extraction-code changes since that baseline. Also found: with the Build
50 explicit-intent gate on, 82 of corpus-full's 91 extraction notes never
reach a model (no "remind me"/"make a note" phrase) — the corpus predates
the gate and needs trigger-bearing variants to measure the current pipeline.

Raised 2026-10-02.

## Done

### Record/Ask tray expand-gesture asymmetry (0-50 mild swipe, 50-100 needed a hard drag)

Not a pre-listed backlog item — a live, precisely-diagnosed UX report, logged
here per this file's own convention. The two halves of the tray's single
continuous drag handle used genuinely different commit rules: the native
0%-50% half benefits from `@gorhom/bottom-sheet`'s own velocity-projected
`snapPoint` formula (a fast flick completes it even over a short drag); the
custom 50%-100% overdrag extension used a simpler binary flick-or-halfway
rule with no such blending, making it feel like it needed a much more
deliberate drag. Fixed by reproducing the library's own formula (exact same
constant) for the custom half too. A follow-up "works in Record, not Ask"
report turned out to be a stale-reload artifact, not a real difference —
both trays share the identical handle/gesture code. Confirmed fixed
on-device in both trays, 2026-10-01.

### RAG retrieval & grounding overhaul (accurate date/time questions, no fabricated content)

Not a pre-listed backlog item — a live, high-stakes debugging arc (user's
own bar: "100 of 100 user questions" must retrieve correctly), logged here
per this file's own convention. Full writeup in PROJECT_STATE_HANDOFF.md's
Build 56 section. Six connected fixes: "latest notes" now uses real
timestamps instead of word matching; a note's own "today"/"last year"/"this
month" now resolve to ITS real recorded date instead of colliding with
whatever "today" means when the question is asked; a real bug where the
model leaked its own internal training example into answers; a new
post-generation check that discards an answer referencing anything not
actually in its source notes or the user's own question; a full date-range
engine (`services/ai/queryDateRange.ts`) so questions like "October last
year," "last quarter," or "around the same time last year" search REAL
timestamps instead of generic keyword similarity; and generation temperature
set to 0 for consistent (not just occasionally-correct) answers. Confirmed
on-device via a dedicated backdated test note and direct log inspection at
every step, 2026-10-01.

### Push to-dos to Google Calendar

Raised 2026-09-29, shipped 2026-09-30. Explicit per-to-do "Send to
Calendar" action (decided over auto-push-on-every-edit), one-way sync
(Xayra → Calendar; edits in Xayra propagate, edits made directly in
Calendar are never pulled back), deleting the to-do deletes the linked
event too.

New `services/sync/calendarSync.ts` reuses driveSync.ts's existing Google
Sign-In session rather than standing up a second one — `driveSync.ts` is
now the de facto shared Google-auth owner (its `ensureConfigured`,
`requireAccessToken`, `withDeveloperErrorHandling`, `DriveSyncError`, and
new `CALENDAR_EVENTS_SCOPE` are all exported for this reuse). The narrower
`calendar.events` scope (not full `calendar` access) is requested
incrementally, only the first time a user actually taps the button — never
upfront, so someone who never uses the feature is never prompted for it.
`db/schema.ts` gained a nullable `google_calendar_event_id` column
(same idempotent `ALTER TABLE` migration pattern as every other column in
this table), deliberately excluded from Drive backup/restore — a linked
event id is tied to a specific Google account/session, not portable data.
`Recurrence` + `recurrenceInterval` mapped directly to RRULE FREQ+INTERVAL
(already the same shape, see db/schema.ts's own doc comment) with no
COUNT/UNTIL, matching this app's own unbounded-recurrence model. A to-do
with a date range (`toDate` set) becomes a genuine multi-day Calendar
event instead of a fixed 30-minute block.

UI: a calendar icon next to delete on every full-size to-do card
(Schedule, Month's day panel, Week/Work Week's preview sheet) — outline
when not linked, filled once it is, tap toggles either way. Two rounds of
live-requested polish after the core feature worked: (1) a success toast
("Sent to Google Calendar"/"Removed...") — the icon's own state change
alone wasn't a confident enough signal that the action had actually
happened; (2) a confirm dialog before acting either direction, matching
the existing delete-confirmation pattern — doubles as inline education
for what the icon does, no separate onboarding needed. The delete
confirmation's own wording now also says "This will also remove it from
your Google Calendar" when the to-do being deleted is linked.

One real external-setup snag hit and resolved live: a `DEVELOPER_ERROR`
(SHA-1/package mismatch) on first real interactive sign-in attempt on this
specific dev-client (debug-signed) build — Drive backup's Android OAuth
client in Google Cloud Console had apparently only ever been registered
with a release-build SHA-1, never tested via a real interactive sign-in on
a debug build before. Fixed by registering a second Android OAuth client
(same package name, debug SHA-1) alongside the existing one — not by
replacing it, which would have broken the release build's own Drive sign-
in. Confirmed working end-to-end on-device: a real Calendar event
verified showing up in Google Calendar itself, 2026-09-30.

## Done

### Month overflow-date tap did nothing / Week-Work Week day-preview bottom sheet

Not pre-listed backlog items — two live requests, fixed/shipped together and
logged here per this file's own convention (see PROJECT_STATE_HANDOFF.md's
Build 55 section for the full writeup). Month: tapping a leading/trailing
overflow-month date was silently a no-op, root-caused to an always-true
disabled check (overflow dates can never have items in that page's strict-
month-filtered set) — fixed, now navigates to and selects that date like
Google Calendar's own month view. Week/Work Week: tapping a day header now
springs open a real draggable bottom sheet (spring-up, drag-handle-to-
dismiss, scrollable) showing that day's reminders — deliberately NOT Month's
always-visible inline panel, per explicit request, reusing the same
`@gorhom/bottom-sheet` mechanics already used elsewhere in the app for a
consistent feel. Confirmed working on-device 2026-09-30.

### Gold Standard Waveform

Raised 2026-09-29, shipped 2026-09-30 after a long multi-round on-device
iteration (`components/CentralRecorderCanvas.tsx`):

- Discovered `CentralRecorderCanvas.tsx` already had a real bar-based
  visualizer, not the static dotted line the request described — the
  actual live bug was that `recorder.amplitude` (real RMS from
  `computeRms`) is correct but tiny relative to full-scale for normal
  speech (the same characteristic `normalizePcmGain` in `wav.ts` already
  compensates for, but only for the saved file, never the live per-chunk
  value) — the waveform looked almost perfectly flat.
- First fix (fixed gain + power curve) overcorrected: normal speech
  saturated to ~max height, losing quiet-vs-loud contrast. Replaced with
  peak-normalizing live against the recording's own loudest moment so far
  (slowly decaying) instead of a guessed constant.
- Reshaped bars into a genuine symmetric center-out "equalizer" per
  explicit spec — live-reported as looking like "a static bell curve," a
  fair critique: every bar showed the same live value scaled by a fixed
  shape, which can never look like a real waveform.
- Rewrote as a true rolling history ring buffer (each bar = a distinct
  recent sample, new data enters right, scrolls left) per explicit
  request, with Skia considered and declined (not an existing dependency;
  pure Reanimated already handles far heavier UI in this app, e.g. the
  calendar carousel, at 60fps) in favor of a pure UI-thread
  shared-value/`useAnimatedStyle` approach.
- That rewrite briefly rendered fully blank — root-caused via temporary
  diagnostic logging to `withTiming()` called inline on a plain computed
  local (not assigned to a persistent shared value's own `.value`),
  which produced `NaN` for every bar's height. Fixed by giving each bar
  its own shared value, smoothed via a `useAnimatedReaction` performing a
  real assignment (`displayedLevel.value = withTiming(...)`) — the
  actually-supported pattern.
- Final polish: switched that smoothing from a fixed-duration ease (still
  looked "stepped," since it fully settled between the ~100-200ms chunk
  arrivals) to an over-damped spring, which is always still gliding toward
  a shifting target rather than settling-then-jumping; separately replaced
  the transcribing/processing state's traveling left-to-right pulse
  (correctly flagged as "moving tall bars over time, a progress tracker
  not a live visualizer") with a synchronized breathing animation shared
  by all bars at once; added 20px more clearance above the row so peaks
  can't touch the button's outer ring.
- Confirmed satisfactory on-device 2026-09-30.

### Recorded-notes tray frozen on first open until you tap a note

Not a pre-listed backlog item — a live bug report, fixed and logged here per
this file's own convention. Symptom: pulling the History sheet's handle up
to Notes mode, the list wouldn't scroll at all until opening then closing a
note's detail popup, after which it worked normally. Root cause, traced into
`@gorhom/bottom-sheet`'s own source: `HistorySheet.tsx`'s "IDLE PEEK
ISOLATION" fully unmounted the list while the sheet sat collapsed, mounting
it fresh only once expanded — but the library registers a scrollable's
native handle with its internal gesture coordinator via a ONE-SHOT
`useEffect` (`useScrollableSetter.ts`, calls `findNodeHandle(ref.current)`
once, never retries). Mounting the list that late raced the native view not
being attached yet, silently failing registration; the popup open/close
happened to force a remount that won the race by luck. Fixed by keeping the
list always mounted from the sheet's first render (hidden via `opacity: 0` +
`pointerEvents="none"` while collapsed instead of a full unmount), so
registration succeeds well before the user ever expands it. Confirmed
on-device 2026-09-30.

### Schedule view now scrolls

Root cause was two layered bugs: (1) the `SectionList` itself never got its
own `flex: 1`, so it never established a bounded scrollable viewport; (2)
after fixing that, it showed a scrollbar but still couldn't be dragged —
`CalendarTaskCard`'s rows use gesture-handler's own `TouchableOpacity`,
which doesn't negotiate touch/scroll with a plain RN `SectionList` (same
class of bug already fixed for DayLayout/WeekGridLayout's ScrollViews).
Rewrote as RNGH's own `FlatList` with a flattened row array. A first version
also added `stickyHeaderIndices` for the section-header sticky behavior, but
that crashed the app on-device (Fabric `addViewAt` mounting exception) —
RNGH's FlatList uses its own native scroll-view class and doesn't implement
that prop's native reparenting at all (confirmed via its source). Removed
it; headers scroll normally now instead of sticking. Confirmed working
on-device 2026-09-30.

### "Today" pill sits left of the right arrow

Was pushing the right arrow's position around when it appeared/disappeared,
because it rendered after (to the right of) the arrow, letting the flexible
label column absorb the size change and shift everything to its right.
Reordered so the arrow is the trailing, fixed-width element — flexbox then
keeps it anchored to the row's edge regardless of the chip. Confirmed fixed
on-device 2026-09-30.

### Note/Ask text box now multiline with a real enter key

`returnKeyType="send"` was hiding the keyboard's own newline glyph and
hijacking Enter to submit. Made the input `multiline`, removed
`returnKeyType`/`onSubmitEditing`, and made the dedicated arrow button the
only way to submit (same pattern WhatsApp/Telegram use). Capped to 5 visible
lines via `numberOfLines` + matching `lineHeight`/`maxHeight` so earlier
lines scroll out of view instead of the box growing indefinitely. Confirmed
on-device 2026-09-30.

### Month/Week grid native render cost (~500ms per page) / continuous swipe for Week/Work Week/Month

Originally scoped as "reduce native view count per page" (fewer
`TouchableOpacity`s, virtualized rows). Shipped as a bigger architecture
change instead: MonthLayout's per-cell `TouchableOpacity`s replaced with one
shared gesture handler, WeekGridLayout's duplicate per-column hour lines
replaced with one shared layer, and — after that alone still weren't enough
for a seamless drag — the ghost-preview swipe mechanism was replaced
entirely with a keyed, always-real page carousel that pre-mounts neighbor
pages off-screen during idle time instead of paying a mount cost at the
moment of commit. Continuous 1:1-drag swipe is now live on all four grid
views (Day/Work Week/Week/Month), not just Day. Known residual: a minor
flicker/lag on some devices — explicitly parked, not being chased further
right now; Pixel 9 is the next real benchmark.

