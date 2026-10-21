/**
 * Gate 2 (approved Option A): Android system backup and device transfer are
 * off for Xayra, so no app file — in particular expo-notifications' store of
 * reminder text — leaves the phone through Android's backup. The effective
 * manifest is verified by a prebuild in the Gate 2 report; this pins the
 * configuration that produces it.
 */
import appJson from "../app.json";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../plugins/withNoSystemBackup");

const plugins = appJson.expo.plugins as (string | [string, Record<string, unknown>])[];
const names = plugins.map((p) => (Array.isArray(p) ? p[0] : p));

describe("Android system backup is off", () => {
  it("app.json disables allowBackup", () => {
    expect((appJson.expo.android as { allowBackup?: boolean }).allowBackup).toBe(false);
  });

  it("expo-secure-store's own backup rules are switched off, and our plugin runs after it", () => {
    const secureStore = plugins.find((p) => Array.isArray(p) && p[0] === "expo-secure-store") as [string, Record<string, unknown>];
    expect(secureStore?.[1]).toEqual({ configureAndroidBackup: false });
    expect(names.indexOf("./plugins/withNoSystemBackup")).toBeGreaterThan(names.indexOf("expo-secure-store"));
  });

  it("covers every backup domain", () => {
    expect(plugin.DOMAINS).toEqual(
      expect.arrayContaining(["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"])
    );
  });

  it("Android 12+: every domain excluded from BOTH cloud backup and device transfer, nothing included", () => {
    const xml: string = plugin.extractionRulesXml();
    expect(xml).not.toMatch(/<include/);
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = xml.split(`<${section}>`)[1].split(`</${section}>`)[0];
      for (const d of plugin.DOMAINS) expect(body).toContain(`<exclude domain="${d}" path="." />`);
    }
  });

  it("Android 11 and lower: every domain excluded, nothing included", () => {
    const xml: string = plugin.backupRulesXml();
    expect(xml).not.toMatch(/<include/);
    for (const d of plugin.DOMAINS) expect(xml).toContain(`<exclude domain="${d}" path="." />`);
  });
});
