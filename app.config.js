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
const PRODUCING_COMMANDS = ["prebuild", "run:android", "run:ios", "build", "update", "submit"];

function assertProductionReleaseAllowed() {
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
  if (gate.productionBlocked !== false) {
    throw new Error(
      `Production release blocked by release-gate.json: ${gate.reason}\n` +
        (gate.blockers ?? []).map((item) => `  - ${item}`).join("\n")
    );
  }
}

module.exports = ({ config }) => {
  const variant = VARIANTS[process.env.APP_VARIANT];
  if (!variant) {
    assertProductionReleaseAllowed();
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
