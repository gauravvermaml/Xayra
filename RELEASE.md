# Release process

Production builds are deliberately hard to make by accident. Each step
below needs the maintainer's explicit approval.

## The release gate

`release-gate.json` decides whether a production artifact may be built.
`app.config.js` enforces it whenever an EAS build or update, or a local
production prebuild or run, is attempted:

- `"productionBlocked": true` blocks every production build, update and
  submit. The open blockers are listed in the file. An unreadable gate file
  also blocks.
- The only exception is `internalTestingBuild`: one EAS build of one named
  version and versionCode, inside a window of at most 48 hours. It allows
  building the AAB only — `submit` and `update` stay blocked, and local
  prebuilds of the production package are refused.
- Development variants, `expo start` and `expo export` are never blocked.

`main` must always carry a blocked gate with no exception; CI checks this.

## Making an internal testing build

1. Bump `version` and `android.versionCode` in `app.json` in a reviewed
   commit on a `release/<version>` branch. (`eas.json` has
   `autoIncrement: false`, so the gate's exact versionCode check holds.)
2. Open the window: add `internalTestingBuild` (version, versionCode,
   `openedAt`, `expiresAt` no more than 48 h later) in its own commit.
3. Run the EAS production build from that commit. Record the build ID and
   commit.
4. Close the window straight after the build: remove `internalTestingBuild`
   in the next commit.
5. Verify the AAB: package, version and versionCode, upload-key signer,
   `allowBackup="false"` and the backup rules, and the permission list.
6. Tag the build source: annotated tag `v<version>-<versionCode>` on the
   commit the build came from.
7. Push the branch and tag, and fast-forward `main` once approved.
8. The maintainer uploads the AAB to Google Play by hand. Nothing in this
   repository submits to Play.

`.easignore` replaces `.gitignore` for EAS uploads, so it must contain every
`.gitignore` rule (CI checks this) plus `docs/`.

## Builds so far

| Version | versionCode | EAS build | Source tag |
|---|---|---|---|
| 2.0.0 | 52 | `4cd4b829-8ae3-4673-85ba-e94f69bfd3a2` | `v2.0.0-52` (8373c01) |

Earlier builds are listed in [CHANGELOG.md](CHANGELOG.md).
