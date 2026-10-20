/**
 * Release batch 1: plain error text on screens, and the download notification
 * never asking for permission before the vault is open.
 */
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn() }));

import { DATABASE_MESSAGE, NETWORK_MESSAGE, classifyErrorText, userFacingMessage } from "../services/errors/userMessage";
import { googleStatusMessage } from "../services/sync/driveErrors";

describe("userFacingMessage", () => {
  it("passes Xayra's own messages through", () => {
    const authored = "That recovery code doesn't unlock this backup. Check it and try again. Nothing was changed.";
    expect(userFacingMessage(new Error(authored), "fallback")).toBe(authored);
    expect(userFacingMessage(new Error("The fingerprint check timed out. Try again."), "fallback")).toBe(
      "The fingerprint check timed out. Try again."
    );
  });

  it("turns raw network errors into a connection message", () => {
    for (const raw of [
      'fetch failed: java.net.UnknownHostException: Unable to resolve host "www.googleapis.com": No address associated with hostname',
      "Network request failed",
      "java.net.SocketTimeoutException: timeout",
      "NetworkError", // Google Play services' token request
    ]) {
      expect(userFacingMessage(new Error(raw), "fallback")).toBe(NETWORK_MESSAGE);
    }
  });

  it("turns raw database errors into a plain message", () => {
    expect(userFacingMessage(new Error("sqlite query error: no such column: updated_at"), "fallback")).toBe(DATABASE_MESSAGE);
  });

  it("never shows developer diagnostics or engine errors", () => {
    expect(userFacingMessage(new Error("Package Name: x\nRuntime SHA-1: AA:BB\nNative Error: code=10"), "Couldn't connect.")).toBe(
      "Couldn't connect."
    );
    expect(userFacingMessage(new TypeError("undefined is not a function"), "Something went wrong.")).toBe("Something went wrong.");
    expect(userFacingMessage(new Error("Injected failure at commitMode"), "Nothing was switched.")).toBe("Nothing was switched.");
    expect(userFacingMessage(null, "fallback")).toBe("fallback");
  });

  it("classifies without leaking", () => {
    expect(classifyErrorText("Google Drive is busy right now. Try again in a few minutes.")).toBe("authored");
  });
});

describe("googleStatusMessage", () => {
  it("says what to do for each failure class, without the raw body", () => {
    expect(googleStatusMessage("Google Drive", 401)).toMatch(/reconnect your Google account/);
    expect(googleStatusMessage("Google Drive", 403, '{"reason":"storageQuotaExceeded"}')).toMatch(/storage is full/);
    expect(googleStatusMessage("Google Drive", 403, '{"reason":"userRateLimitExceeded"}')).toMatch(/busy/);
    expect(googleStatusMessage("Google Calendar", 503)).toBe("Google Calendar is busy right now. Try again in a few minutes.");
    expect(googleStatusMessage("Google Drive", 400, '{"error":"secret body"}')).not.toMatch(/secret/);
  });
});

describe("download notification permission", () => {
  const mockRequest = jest.fn(async () => ({ granted: true }));
  const mockSchedule = jest.fn(async () => "id");

  function load() {
    jest.resetModules();
    jest.doMock("expo-notifications", () => ({
      setNotificationHandler: jest.fn(),
      addNotificationResponseReceivedListener: jest.fn(),
      setNotificationChannelAsync: jest.fn(async () => undefined),
      getPermissionsAsync: jest.fn(async () => ({ granted: false })),
      requestPermissionsAsync: mockRequest,
      scheduleNotificationAsync: mockSchedule,
      dismissNotificationAsync: jest.fn(async () => undefined),
      AndroidImportance: { MIN: 1, HIGH: 4 },
      AndroidNotificationPriority: { LOW: "low" },
    }));
    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }));
    return require("../services/notifications/downloadNotification");
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    mockRequest.mockClear();
    mockSchedule.mockClear();
  });

  it("doesn't ask before the vault is open (the dialog would cancel the fingerprint prompt)", async () => {
    const mod = load();
    mod.syncDownloadNotification({ status: "downloading", progressPercent: 10 });
    await flush();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it("asks once the vault is open", async () => {
    const mod = load();
    mod.allowDownloadNotificationPermissionPrompt();
    mod.syncDownloadNotification({ status: "downloading", progressPercent: 20 });
    await flush();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });
});
