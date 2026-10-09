// Development variant: `APP_VARIANT=development` builds "Xayra Dev"
// (com.anonymous.silentconfidant.dev), which installs alongside the Play
// build on a test device without touching it or its encrypted vault.
//
// Inert unless that variable is set: production builds (EAS, local) get
// app.json's config back unchanged, and EAS still bumps versionCode in
// app.json as before.
module.exports = ({ config }) =>
  process.env.APP_VARIANT !== "development"
    ? config
    : {
        ...config,
        name: "Xayra Dev",
        scheme: "xayra-dev",
        android: { ...config.android, package: `${config.android.package}.dev` },
      };
