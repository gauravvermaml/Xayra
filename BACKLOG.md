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
