/**
 * Phase 1 P1-2 (qa/05-consolidated-triage.md): `writePreferences()` used to
 * be an unguarded read-modify-write against a shared in-memory cache — two
 * overlapping calls could both read the same pre-write snapshot before
 * either committed, silently discarding whichever patch landed first.
 */

const mockFsStore: Record<string, string> = {};

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///fake-doc-dir/",
  readAsStringAsync: jest.fn((path: string) => {
    if (!(path in mockFsStore)) {
      return Promise.reject(new Error("ENOENT: no such file"));
    }
    return Promise.resolve(mockFsStore[path]);
  }),
  writeAsStringAsync: jest.fn((path: string, content: string) => {
    mockFsStore[path] = content;
    return Promise.resolve();
  }),
}));

describe("writePreferences (Phase 1 P1-2: lost-update race)", () => {
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(mockFsStore)) {
      delete mockFsStore[key];
    }
  });

  it("does not silently drop either patch when two writes overlap", async () => {
    const { writePreferences, readPreferences } = require("../services/settings/preferences");

    const first = writePreferences({ allowCellularDownloads: true });
    const second = writePreferences({ threadEscalationStatus: "accepted" });
    await Promise.all([first, second]);

    const final = await readPreferences();
    expect(final.allowCellularDownloads).toBe(true);
    expect(final.threadEscalationStatus).toBe("accepted");
  });

  it("keeps every patch correct across many concurrent writers, not just two", async () => {
    const { writePreferences, readPreferences } = require("../services/settings/preferences");

    await Promise.all([
      writePreferences({ allowCellularDownloads: true }),
      writePreferences({ threadEscalationStatus: "accepted" }),
      writePreferences({ threadEscalationStatus: "accepted" }),
      writePreferences({ llamaThreadCount: 6 }),
      writePreferences({ onboardingCalibrationAttemptInFlight: true }),
    ]);

    const final = await readPreferences();
    expect(final.allowCellularDownloads).toBe(true);
    expect(final.threadEscalationStatus).toBe("accepted");
    expect(final.threadEscalationStatus).toBe("accepted");
    expect(final.llamaThreadCount).toBe(6);
    expect(final.onboardingCalibrationAttemptInFlight).toBe(true);
  });

  it("still applies a later write even if an earlier concurrent write failed", async () => {
    const FileSystem = require("expo-file-system/legacy");
    const { writePreferences, readPreferences } = require("../services/settings/preferences");

    (FileSystem.writeAsStringAsync as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("simulated disk write failure"))
    );

    const first = writePreferences({ allowCellularDownloads: true }).catch(() => "failed" as const);
    const second = writePreferences({ threadEscalationStatus: "accepted" });

    await expect(first).resolves.toBe("failed");
    await second;

    const final = await readPreferences();
    expect(final.threadEscalationStatus).toBe("accepted");
  });
});
