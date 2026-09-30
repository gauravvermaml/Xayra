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

### Push to-dos to Google Calendar

Let a user send a to-do (one, or all of them) to their real Google Calendar
— not just keep it inside Xayra's own calendar view.

**Why parked, not just implemented**: needs Google Calendar API scope/
consent added on top of whatever Google Sign-In access this app already
has for Drive backup (`services/` — check what scopes the existing
Google Sign-In flow requests before assuming a re-consent prompt is
avoidable), a real API client for creating/updating events, and a mapping
decision for recurrence (`db/schema.ts`'s `Recurrence` type) onto Google
Calendar's own RRULE format, which don't obviously line up one-to-one.

**Open questions to resolve when picked up**: push automatically on
create/edit, or an explicit "Send to Calendar" action per to-do; one-way
push only, or does an edit/completion in Xayra need to update the Calendar
event too; does deleting a to-do in Xayra delete the Calendar event.

Raised 2026-09-29.

## Done

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

