/**
 * Xayra starts no foreground service: playback, the wake chime and spoken
 * answers run only while the app is open, and recording never asks for
 * background capture. expo-audio's config plugin adds a mediaPlayback service
 * plus FOREGROUND_SERVICE permissions unless told not to, and Google Play then
 * requires a foreground-service declaration for a feature Xayra doesn't have.
 */
import appJson from "../app.json";

type PluginEntry = string | [string, Record<string, unknown>];

describe("foreground-service configuration", () => {
  const android = appJson.expo.android as { permissions?: string[] };
  const plugins = appJson.expo.plugins as PluginEntry[];

  it("requests no foreground-service permission", () => {
    expect((android.permissions ?? []).filter((p) => p.includes("FOREGROUND_SERVICE"))).toEqual([]);
  });

  it("turns off expo-audio's background playback and recording services", () => {
    const entry = plugins.find((p) => Array.isArray(p) && p[0] === "expo-audio");
    expect(Array.isArray(entry)).toBe(true);
    const options = (entry as [string, Record<string, unknown>])[1];
    expect(options.enableBackgroundPlayback).toBe(false);
    expect(options.enableBackgroundRecording ?? false).toBe(false);
  });
});
