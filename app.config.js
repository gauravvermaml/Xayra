// Build variants, selected by APP_VARIANT. Inert unless it's set: production
// builds (EAS, local) get app.json's config back unchanged, and EAS still
// bumps versionCode in app.json as before.
//
// - development → "Xayra Dev" (com.anonymous.silentconfidant.dev), installs
//   alongside the Play build on a test device without touching it or its
//   encrypted vault. Signed with the stock debug keystore.
// - devtest → "Xayra Test" (com.anonymous.silentconfidant.devtest), the
//   emulator-only variant for Google Drive recovery testing. Signed with a
//   PRIVATE keystore (plugins/withPrivateTestSigning.js), so an OAuth client
//   can be registered for it without the public debug key. Never installed
//   on a personal device.
const VARIANTS = {
  development: { name: "Xayra Dev", scheme: "xayra-dev", suffix: ".dev", privateSigning: false },
  devtest: { name: "Xayra Test", scheme: "xayra-devtest", suffix: ".devtest", privateSigning: true },
};

// Production release gate (release-gate.json). While it says blocked, any
// attempt to produce a PRODUCTION artifact fails here: an EAS build or update
// of the production package, or a local native prebuild/run of it. Dev/Test
// variants, `expo start` and `expo export` (JS-only verification) are
// unaffected. Fails closed: an unreadable gate file blocks too. Lifting it is a
// reviewed commit that sets "productionBlocked": false — there's no override.
//
// The one exception while blocked is `internalTestingBuild` (see
// internalTestingBuildAllowed below): a single EAS build of one named
// version/versionCode, inside a window of at most 48 hours. It authorises
// building the AAB only. Which Play track the AAB reaches is decided by a
// manual Play Console upload; submit and update stay blocked.
const PRODUCING_COMMANDS = ["prebuild", "run:android", "run:ios", "build", "update", "submit"];
const INTERNAL_BUILD_MAX_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * `{ version, versionCode, openedAt, expiresAt }` in release-gate.json allows a
 * producing command only when ALL of these hold:
 *  - it's an EAS build: the EAS build server (EAS_BUILD=true, production
 *    profile) or the local `eas build` CLI — never a local `expo prebuild` /
 *    `run:android`, and never `submit` or `update`;
 *  - the app's version AND versionCode equal the named ones exactly (so an
 *    automatic versionCode increment fails the build instead of passing);
 *  - now is inside [openedAt, expiresAt), and that window is valid and no
 *    longer than 48 hours.
 * Removing the entry (or letting it expire) closes it.
 */
function internalTestingBuildAllowed(exception, config) {
  if (!exception || typeof exception !== "object") return false;
  const openedAt = Date.parse(exception.openedAt);
  const expiresAt = Date.parse(exception.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(openedAt) || !Number.isFinite(expiresAt)) return false;
  if (expiresAt <= openedAt || expiresAt - openedAt > INTERNAL_BUILD_MAX_WINDOW_MS) return false;
  if (now < openedAt || now >= expiresAt) return false;
  const argv = process.argv;
  if (argv.includes("submit") || argv.includes("update")) return false;
  const onEasBuildServer = process.env.EAS_BUILD === "true" && process.env.EAS_BUILD_PROFILE === "production";
  const localEasBuildCli = argv.includes("build") && /eas-cli/.test(argv[1] ?? "");
  if (!onEasBuildServer && !localEasBuildCli) return false;
  return (
    typeof exception.version === "string" &&
    Number.isInteger(exception.versionCode) &&
    config.version === exception.version &&
    config.android?.versionCode === exception.versionCode
  );
}

function assertProductionReleaseAllowed(config) {
  const easBuild = Boolean(process.env.EAS_BUILD || process.env.EAS_BUILD_PROFILE);
  const producing = easBuild || process.argv.some((arg) => PRODUCING_COMMANDS.includes(arg));
  if (!producing) {
    return;
  }
  let gate;
  try {
    gate = require("./release-gate.json");
  } catch {
    gate = { productionBlocked: true, reason: "release-gate.json is missing or unreadable." };
  }
  if (gate.productionBlocked !== false && !internalTestingBuildAllowed(gate.internalTestingBuild, config)) {
    throw new Error(
      `Production release blocked by release-gate.json: ${gate.reason}\n` +
        (gate.blockers ?? []).map((item) => `  - ${item}`).join("\n")
    );
  }
}

module.exports = ({ config }) => {
  const variant = VARIANTS[process.env.APP_VARIANT];
  if (!variant) {
    assertProductionReleaseAllowed(config);
    return config;
  }
  return {
    ...config,
    name: variant.name,
    scheme: variant.scheme,
    android: { ...config.android, package: `${config.android.package}${variant.suffix}` },
    plugins: variant.privateSigning ? [...(config.plugins ?? []), "./plugins/withPrivateTestSigning"] : config.plugins,
  };
};
