# Changelog

Xayra versions built for Google Play internal testing. Xayra isn't publicly
released. Earlier history (as "Silent Confidant" and "Remi", and builds
before 1.0.39) is in [PROJECT_STATE_HANDOFF.md](PROJECT_STATE_HANDOFF.md).

## 2.0.0 (52)

A redesign, local encryption and encrypted backup.

- **New design** — the Halo/Orbit home with the emblem as the microphone,
  a labelled dock, a tray for answers, Plus Jakarta Sans and DM Sans, and a
  dark palette. Cancel while recording discards the recording.
- **Encrypted on the phone** — notes, to-dos and the search index move into
  an SQLCipher database with a 256-bit key in Android Keystore. Existing
  unencrypted data is migrated and verified row for row; the old copy is
  removed only when you approve.
- **Encrypted Google Drive backup** — verified backup generations,
  insert-only merges, restore from every phone's backup, "Recover my notes"
  after a fingerprint change, and an optional Extra Privacy mode locked by
  a recovery code.
- **Microphone handling** — one microphone owner for recording, Handsfree
  and voice Ask, released reliably.
- **Safeguards** — Android Auto Backup and device transfer are off (they
  could copy reminder text unencrypted); reminders are re-armed after a
  force-stop; dev-only screens are unavailable in other builds; the
  foreground-service permissions were removed.
- **Fixes** — a double tap on Send no longer closes the keyboard mid-entry;
  backup reliability with concurrent edits and dropped connections.

## 1.0.43 (51)

Release stabilisation: the first-launch notification prompt waits until the
vault opens, plain error messages, separate consent for Drive and Calendar,
and recovery in production builds.

## 1.0.42 (50)

Ask progress in the answer tray ("Looking through your memories…", "Found N
related memories…"), the voice tray shown at the end of capture, and no
model run when no notes match.

## 1.0.41 (49)

Launcher shortcuts ("Record with Xayra", "Ask Xayra") and an immediate
Cancel for processing.

## 1.0.40 (48)

Note editing (carried into Drive backup), temporary input audio, one-tap
voice capture that finishes after silence, and consistent copy across
Record and Ask.

## 1.0.39 (47)

RAG Grounding v1: deterministic date resolution, relationship grounding and
answer validation. The release-candidate baseline.
