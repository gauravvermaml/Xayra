# Privacy Policy — Xayra

**Last updated: August 21, 2026**

Xayra ("the app," "we," "our") is built on a single premise: your data stays on your device. This policy explains exactly what that means in practice.

## Summary

Xayra collects nothing. There is no account, no telemetry, no analytics SDK, and no server that your notes, recordings, or questions are ever sent to. Every feature described below runs entirely on your phone's hardware.

## 1. On-Device Local Processing

All AI processing in Xayra happens locally, on your device, using models stored in the app's private storage:

- **Voice recognition (speech-to-text)** is performed on-device using a local Whisper model (`whisper.cpp`). Audio is never uploaded anywhere for transcription.
- **Semantic search (vector embeddings)** is generated on-device using a local ONNX embedding model. Your note content never leaves the device to be embedded or indexed.
- **Chat answers (LLM inference)** are generated on-device using a local Llama 3.2 model (`llama.cpp`). Your questions and the notes used to answer them are processed entirely within the app's local runtime — no prompt, question, or note content is ever transmitted to a remote AI service, API, or third party.

None of these features require, use, or silently fall back to a network connection or a cloud API. If a required model file is missing from the device, the corresponding feature simply does not work — it does not substitute a cloud call.

## 2. Zero Data Collection

Xayra does not collect, transmit, or have access to:

- Usage analytics or telemetry of any kind
- Crash reports sent to a remote server
- Device identifiers, advertising IDs, or tracking pixels
- Your notes, transcripts, recordings, or chat history
- Any data shared with third-party services, advertisers, or analytics providers

We do not operate any backend server for this app. There is nothing for Xayra to send your data to, because no such infrastructure exists.

## 3. Google Drive Backups (Optional, User-Initiated)

Xayra offers an optional backup feature that is **off by default** and only runs when you explicitly trigger it. When you choose to back up:

- The backup is written exclusively to your Google Drive's **application data folder** (the `drive.appdata` scope) — a hidden, per-app storage area that is not visible in your normal Drive file listing, cannot be browsed by you or any other app in the regular Drive UI, and is only accessible to Xayra itself.
- Xayra requests no broader Drive permission. It cannot see, read, list, or modify any other file in your Google Drive account.
- Backup and restore actions only occur when you initiate them from within the app. Xayra never backs up data automatically or in the background without your action.

Google's handling of data stored via the Drive API is governed by Google's own Privacy Policy (https://policies.google.com/privacy). Xayra's role is limited to writing your encrypted local data to your own hidden app-data folder at your request.

## 4. Data Storage, Retention & Deletion

- All notes, transcripts, and audio metadata are stored locally in an encrypted SQLite database on your device (encrypted at rest via SQLCipher).
- The database encryption key is stored in your device's secure keystore/keychain, gated behind biometric authentication wherever your device has biometrics enrolled.
- **You control retention entirely.** Data persists only as long as the app remains installed (or until you delete it within the app, or delete an optional Drive backup yourself).
- **Uninstalling the app permanently and irreversibly deletes all local data.** There is no server-side copy to recover, because none exists. If you created an optional Drive backup, that backup remains in your `drive.appdata` folder until you delete it yourself or revoke the app's Drive access, at which point Google will remove the associated app-data folder per its standard `drive.appdata` handling.

## 5. Permissions

Xayra requests only the device permissions required for its on-device features to function (e.g., microphone access for voice notes, and — only if you choose to use backup — Google Drive `appdata` scope access). No permission is used for any purpose beyond the feature it enables.

## 6. Children's Privacy

Xayra does not knowingly collect data from anyone, including children, because it does not collect data at all. The app is not directed at children and contains no mechanism for data collection of any kind, age-independent.

## 7. Changes to This Policy

If this policy changes, the updated version will be published in-app and in this document with a revised "Last updated" date. Material changes affecting how backups or on-device processing work will be reflected here before being shipped.

## 8. Contact

Questions about this policy can be directed to the developer via the contact details listed on the Xayra Google Play Store listing.
