# Development

## Requirements

- Node.js 24 and npm
- Android SDK and NDK; an Android emulator or device
- JDK 17 for Gradle builds (newer JDKs break the native CMake step)

## Install and verify

```bash
npm ci                         # postinstall applies patches/ via patch-package
npx tsc --noEmit               # types
npx jest                       # unit tests
npx expo export --platform android   # JS bundle
```

These checks don't prove native code links. After changing a native
dependency or anything in `patches/`, do a native build.

On Windows, run `npm install` for packages with a native download step
(for example `llama.rn`) from PowerShell, not Git Bash — Git Bash's `tar`
misreads `C:\` paths.

## Build variants

Variants are selected with `APP_VARIANT` (`app.config.js`). The generated
`android/` folder is not tracked and must be regenerated when you switch.

| Variant | Package | Signing | Use |
|---|---|---|---|
| Xayra Dev (`development`) | `com.anonymous.silentconfidant.dev` | public debug keystore (tracked) | Everyday development; installs alongside the Play build. No Google sign-in. |
| Xayra Test (`devtest`) | `com.anonymous.silentconfidant.devtest` | private keystore outside the repo | Emulator only, for Google Drive testing with a dedicated test account |
| Production (unset) | `com.anonymous.silentconfidant` | EAS / Play App Signing | Release builds only, behind the release gate ([RELEASE.md](RELEASE.md)) |

Xayra Dev:

```bash
APP_VARIANT=development CI=1 npx expo prebuild --clean --no-install --platform android
cd android && APP_VARIANT=development ./gradlew assembleDebug
adb install android/app/build/outputs/apk/debug/app-debug.apk
APP_VARIANT=development npx expo start --dev-client   # then: adb reverse tcp:8081 tcp:8081
```

Xayra Test reads its signing values from `~/.gradle/gradle.properties`
(`XAYRA_TEST_STORE_FILE`, `XAYRA_TEST_STORE_PASSWORD`, `XAYRA_TEST_KEY_ALIAS`,
`XAYRA_TEST_KEY_PASSWORD`) and refuses to build without them:

```bash
APP_VARIANT=devtest CI=1 npx expo prebuild --clean --no-install --platform android
cd android && APP_VARIANT=devtest ./gradlew assembleRelease
```

Safety rules:

- Never run `uninstall`, `pm clear` or `install -r` against the production
  package on a device holding a real vault.
- Never install Xayra Test on a personal device or sign it in with a
  personal Google account. All variants share one Google Cloud project, so
  they see the same hidden Drive folder for an account.
- Test data is synthetic. Never commit real notes as fixtures.

## Models

The app downloads its models during first-launch setup. To side-load them
instead, copy them into the app's `files/` directory (debuggable builds):

```bash
adb push <file> /data/local/tmp/<file>
adb shell run-as com.anonymous.silentconfidant.dev cp /data/local/tmp/<file> files/<file>
adb shell rm /data/local/tmp/<file>
```

In Git Bash, prefix adb commands with `MSYS_NO_PATHCONV=1`.

| File | Purpose |
|---|---|
| `ggml-base.en.bin` | Whisper speech-to-text |
| `bge-small-en-v1.5-quantized.onnx`, `bge-small-en-v1.5-vocab.txt` | Embeddings and tokenizer vocabulary |
| `qwen-task-extractor-q4_k_m.gguf` | Language model (answers and to-do extraction) |

Retired model files are deleted by the app at startup.
`scripts/sync-model-to-r2.sh` publishes a model to the model server
(maintainer only).

## Evaluation tools

Desktop llama.cpp with the production model at
`models/qwen-task-extractor-q4_k_m.gguf`:

```bash
npx tsx scripts/eval/runTemporalRegression.ts
npx tsx scripts/eval/runRagComparison.ts --config fine-tuned --out <dir>
npx tsx scripts/eval/runRelationshipSweep.ts <dir with rag-comparison.json>
```

## Troubleshooting

- **Blank screen after installing a dev build** — Metro has probably hung.
  If `curl http://localhost:8081/status` doesn't answer, restart with
  `npx expo start --clear`, re-run `adb reverse tcp:8081 tcp:8081` and
  cold-launch the app.
- **"no such column" after adding a migration** — the database connection
  survives Fast Refresh, so migrations run once per process. Force-stop the
  app (`adb shell am force-stop <package>`) and relaunch.
- **A native dependency's Gradle script is broken** — fix it in
  `node_modules`, delete that package's `android/.cxx` and `android/build`,
  then `npx patch-package <name>`. Check it survives a clean `npm ci`.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`
and `release/**`: `npm ci`, `patch-package`, the repository policy checks
(`scripts/ci/checkRepoPolicy.js`), `tsc` and Jest. It never builds, signs
or uploads anything.
