/**
 * Regression: driveSync → todoManager → calendarSync → driveSync is an import
 * cycle, and calendarSync extends DriveSyncError while it loads. When the root
 * layout started importing driveSync first (original-vault recovery), the app
 * crashed at startup with "undefined is not a constructor". The error classes
 * now live in driveErrors.ts; loading driveSync first must work.
 * Only native modules are mocked — todoManager and calendarSync are real.
 */
import * as fs from "fs";
import * as path from "path";

jest.mock("@op-engineering/op-sqlite", () => ({ open: jest.fn(), ANDROID_DATABASE_PATH: "/db/" }));
jest.mock("drizzle-orm/op-sqlite", () => ({ drizzle: jest.fn() }));
jest.mock("@react-native-async-storage/async-storage", () => ({ getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }));
jest.mock("expo-app-signature", () => ({ getRuntimePackageName: () => "com.anonymous.silentconfidant", getSigningSha1Fingerprint: () => null }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(), getRandomBytesAsync: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(), isEnrolledAsync: jest.fn() }));
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  AndroidImportance: { HIGH: 4 },
  SchedulableTriggerInputTypes: { DATE: "date" },
}));
jest.mock("@react-native-google-signin/google-signin", () => ({ GoogleSignin: {}, isSuccessResponse: jest.fn() }));
jest.mock("../services/ai/localEmbeddings", () => ({ EMBEDDING_DIMENSIONS: 384, generateEmbeddingLocal: jest.fn() }));
// Not part of the cycle; mocked only because it pulls in on-device AI modules.
jest.mock("../services/notes/noteManager", () => ({ listNotes: jest.fn(), listNoteRevisions: jest.fn(), mergeMissingNotes: jest.fn() }));

describe("driveSync load order", () => {
  it("loading driveSync first (real todoManager and calendarSync) doesn't crash", () => {
    let loaded: Record<string, unknown> | undefined;
    jest.isolateModules(() => {
      expect(() => {
        loaded = require("../services/sync/driveSync");
      }).not.toThrow();
    });
    expect(typeof loaded?.DriveSyncError).toBe("function");
    let calendar: Record<string, unknown> | undefined;
    jest.isolateModules(() => {
      require("../services/sync/driveSync");
      calendar = require("../services/sync/calendarSync");
    });
    expect(typeof calendar?.CalendarSyncError).toBe("function");
  });

  it("calendarSync takes DriveSyncError from driveErrors, not from the cycle", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "services", "sync", "calendarSync.ts"), "utf8");
    expect(source).toMatch(/import \{ DriveSyncError \} from "\.\/driveErrors";/);
    expect(source).not.toMatch(/DriveSyncError[^;]*from "\.\/driveSync"/);
  });
});
