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

describe("internal-testing build exception (one named version, at most 48 hours)", () => {
  const OPENED = "2026-10-17T00:00:00Z";
  const EXPIRES = "2026-10-19T00:00:00Z"; // 48 h
  const exception = { version: "1.0.43", versionCode: 51, openedAt: OPENED, expiresAt: EXPIRES };
  const release = { ...baseConfig, version: "1.0.43", android: { ...baseConfig.android, versionCode: 51 } };
  const EAS_CLI = "/usr/local/lib/node_modules/eas-cli/bin/run";

  function run(opts: {
    gate?: Record<string, unknown>;
    config?: typeof release;
    env?: Record<string, string>;
    argv: string[];
    now?: string;
  }): () => unknown {
    return () => {
      const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
      const savedArgv = process.argv;
      jest.useFakeTimers({ now: Date.parse(opts.now ?? "2026-10-17T12:00:00Z") });
      try {
        for (const k of ENV_KEYS) delete process.env[k];
        Object.assign(process.env, opts.env ?? {});
        process.argv = opts.argv;
        const gateFile = { productionBlocked: true, reason: "test", ...(opts.gate ?? { internalTestingBuild: exception }) };
        jest.resetModules();
        jest.doMock("../release-gate.json", () => gateFile);
        const factory = require("../app.config.js") as (ctx: { config: typeof release }) => unknown;
        return factory({ config: opts.config ?? release });
      } finally {
        jest.dontMock("../release-gate.json");
        jest.resetModules();
        jest.useRealTimers();
        for (const k of ENV_KEYS) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
        process.argv = savedArgv;
      }
    };
  }
  const BLOCKED = /Production release blocked/;

  it("allows the local `eas build` of exactly 1.0.43 / 51 inside the window", () => {
    expect(run({ argv: ["node", EAS_CLI, "build", "--platform", "android", "--profile", "production"] })).not.toThrow();
  });

  it("allows the EAS build server's production-profile prebuild", () => {
    expect(run({ env: { EAS_BUILD: "true", EAS_BUILD_PROFILE: "production" }, argv: ["node", "expo", "prebuild"] })).not.toThrow();
  });

  it.each([
    ["eas submit", { argv: ["node", EAS_CLI, "submit", "--platform", "android"] }],
    ["eas update", { argv: ["node", EAS_CLI, "update", "--branch", "production"] }],
    ["a local expo prebuild", { argv: ["node", "expo", "prebuild", "--clean"] }],
    ["a local expo run:android", { argv: ["node", "expo", "run:android", "--variant", "release"] }],
    ["a non-EAS `build` command", { argv: ["node", "expo", "build"] }],
    ["the EAS server on another profile", { env: { EAS_BUILD: "true", EAS_BUILD_PROFILE: "preview" }, argv: ["node", "expo", "prebuild"] }],
    ["another version (1.0.44)", { argv: ["node", EAS_CLI, "build"], config: { ...release, version: "1.0.44" } }],
    ["an auto-incremented versionCode (52)", { argv: ["node", EAS_CLI, "build"], config: { ...release, android: { ...release.android, versionCode: 52 } } }],
    ["after it expires", { argv: ["node", EAS_CLI, "build"], now: "2026-10-19T00:00:01Z" }],
    ["before it opens", { argv: ["node", EAS_CLI, "build"], now: "2026-10-16T23:59:59Z" }],
    ["a window longer than 48 hours", { argv: ["node", EAS_CLI, "build"], gate: { internalTestingBuild: { ...exception, expiresAt: "2026-10-19T00:00:01Z" } } }],
    ["an unparseable expiry", { argv: ["node", EAS_CLI, "build"], gate: { internalTestingBuild: { ...exception, expiresAt: "soon" } } }],
    ["no exception entry", { argv: ["node", EAS_CLI, "build"], gate: {} }],
  ])("refuses %s", (_label, opts) => {
    expect(run(opts as Parameters<typeof run>[0])).toThrow(BLOCKED);
  });

  it("is not active in the committed gate file", () => {
    expect(require("../release-gate.json").internalTestingBuild).toBeUndefined();
  });
});
