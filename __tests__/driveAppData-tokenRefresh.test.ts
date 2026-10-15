/**
 * Encrypted-backup Drive calls survive an access token expiring mid-operation
 * (services/backup/driveAppData.ts): one refresh and retry on a 401, and later
 * calls made with the stale token use the fresh one.
 */
jest.mock("expo-file-system/legacy", () => ({ downloadAsync: () => new Promise(() => undefined) }));
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn() }));

import { downloadText, downloadToDisk, setAccessTokenRefresher } from "../services/backup/driveAppData";

it("refreshes once on 401, retries, and reuses the fresh token afterwards", async () => {
  const seen: string[] = [];
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).Authorization);
    seen.push(auth);
    return auth === "Bearer fresh"
      ? ({ ok: true, status: 200, text: async () => "payload" } as Response)
      : ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "" } as Response);
  }) as unknown as typeof fetch;
  const refresher = jest.fn(async () => "fresh");
  setAccessTokenRefresher(refresher);
  expect(await downloadText("stale", "file-1")).toBe("payload");
  expect(await downloadText("stale", "file-2")).toBe("payload");
  expect(refresher).toHaveBeenCalledTimes(1);
  expect(seen).toEqual(["Bearer stale", "Bearer fresh", "Bearer fresh"]);
});

it("a transfer that never answers (dropped connection) fails with a plain message instead of hanging", async () => {
  jest.useFakeTimers();
  try {
    const pending = downloadToDisk("t", "file-3", "file:///stage/x.db");
    const settled = expect(pending).rejects.toThrow("Google Drive didn't respond in time. Check your internet connection and try again.");
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await settled;
  } finally {
    jest.useRealTimers();
  }
});

it("a request that can't be sent becomes the plain connection message", async () => {
  global.fetch = jest.fn(async () => {
    throw new TypeError("Network request failed");
  }) as unknown as typeof fetch;
  await expect(downloadText("t", "file-4")).rejects.toThrow("Xayra couldn't reach Google. Check your internet connection and try again.");
});
