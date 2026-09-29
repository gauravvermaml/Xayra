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

### Month/Week grid native render cost (~500ms per page)

Live on-device logcat timing (one swipe commit traced end to end, timestamps
at every stage) proved WeekGridLayout's and MonthLayout's real NATIVE
commit — not any JS logic, not any gesture/swipe mechanism — takes roughly
500ms per page on the Redmi Note 8 Pro: `renderGridForDate` and
`MonthLayout`'s own render-function BODY both complete in single-digit
milliseconds, but the gap between "JS finished building the tree" and
"React's commit actually lands" (a `useEffect` fired right after commit)
was consistently ~500-550ms across many repeated samples. MonthLayout alone
mounts roughly 35-42 `TouchableOpacity` cells (one per grid day) every time
the page changes; WeekGridLayout draws a full 24-line hourly grid per
column (5 or 7 of them). This cost is real and PRE-EXISTING — it happens
identically via the plain date-navigator arrow buttons, not just via a
swipe — it just wasn't noticeable there because a discrete tap doesn't
promise the instant continuity a drag gesture does.

**Why parked, not just implemented**: fixing it means reducing the actual
number/weight of native views these two layouts create per page — e.g.
swapping MonthLayout's per-cell `TouchableOpacity` for a single gesture
handler doing manual hit-testing over plain `View`s, or virtualizing the
week rows — not a quick tweak, and risks the same kind of gesture-
composition regression already hit once before between this calendar's
swipe and its own vertical scroll (see PROJECT_STATE_HANDOFF.md's Build 50
section, the RNGH `ScrollView` fix).

**Unblocks**: once this is fixed, Week/Work Week/Month can get the same
continuous 1:1-drag swipe Day view already has (see CalendarBody.tsx's own
doc comment on why those three currently use a plain jump-on-release swipe
instead — this item is the reason, not a missing feature).

Raised 2026-09-29.

### Styling pass — Record/Ask half-expanded drawer trays

Both trays (`ChatSheetContent.tsx`, rendered inside `HistorySheet.tsx`'s 50%
stage) need a visual revisit — e.g. the padding between the "Ask anything…"
placeholder text and the expand-arrow micro-chip reads as more generous
than it should.

Raised 2026-09-29.

### Ask mode: auto-scroll to the latest exchange while thinking/answering

In the sheet's 50% stage, asking a new question doesn't reliably scroll the
view down to show it (or the live "thinking"/streaming state) — it can stay
showing the earliest Q&A at the top instead. `ChatSheetContent.tsx` already
wires `scrollToEnd()` to fire on content-size change; worth retesting first
now that the Record/Ask list-swap scroll bug (Build 50) is fixed, since that
may have been suppressing this too rather than it being a separate issue.

Raised 2026-09-29.

### RAG answers should address the user in third person, not first

Notes are transcribed in the user's own first-person voice ("I bought
milk…"), and Xayra's RAG answers currently carry that same "I" straight
through into the response instead of converting it to "you" — reads as
Xayra claiming the user's own actions rather than reporting on them. Needs a
prompt-level fix (`services/ai/localLlama.ts`'s system prompt / "7 laws" —
see `qwen-15b-single-model-cutover` in project memory), not a UI change.

Raised 2026-09-29.
