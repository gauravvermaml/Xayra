/**
 * The production release gate in app.config.js: while release-gate.json says
 * blocked, producing a production artifact fails; development variants and
 * JS-only verification keep working.
 */
const baseConfig = { name: "Xayra", android: { package: "com.anonymous.silentconfidant" }, plugins: [] };
const ENV_KEYS = ["APP_VARIANT", "EAS_BUILD", "EAS_BUILD_PROFILE"];

function evaluate(env: Record<string, string>, argv: string[]): () => unknown {
  return () => {
    const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    const savedArgv = process.argv;
    try {
      for (const k of ENV_KEYS) delete process.env[k];
      Object.assign(process.env, env);
      process.argv = ["node", "expo", ...argv];
      let factory!: (ctx: { config: typeof baseConfig }) => unknown;
      jest.isolateModules(() => {
        factory = require("../app.config.js");
      });
      return factory({ config: baseConfig });
    } finally {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      process.argv = savedArgv;
    }
  };
}

it("the gate is currently closed", () => {
  expect(require("../release-gate.json").productionBlocked).toBe(true);
});

it.each([
  ["an EAS production build", { EAS_BUILD: "true", EAS_BUILD_PROFILE: "production" }, []],
  ["any EAS build of the production package", { EAS_BUILD_PROFILE: "preview" }, []],
  ["a local production prebuild", {}, ["prebuild", "--clean"]],
  ["a local production run:android", {}, ["run:android"]],
  ["an EAS update", {}, ["update", "--branch", "production"]],
  ["an EAS submit", {}, ["submit"]],
])("blocks %s", (_label, env, argv) => {
  expect(evaluate(env, argv)).toThrow(/Production release blocked/);
});

it.each([
  ["JS-only export", {}, ["export", "--platform", "android"]],
  ["the dev server", {}, ["start"]],
  ["a Xayra Test prebuild", { APP_VARIANT: "devtest" }, ["prebuild"]],
  ["a Xayra Dev prebuild", { APP_VARIANT: "development" }, ["prebuild"]],
])("allows %s", (_label, env, argv) => {
  expect(evaluate(env, argv)).not.toThrow();
});
