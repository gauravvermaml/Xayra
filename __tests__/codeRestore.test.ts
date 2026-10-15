/**
 * Restoring an Extra Privacy backup with the recovery code (Settings and
 * Archive share this): the right code restores, a wrong code or a failed
 * restore keeps the prompt open with a plain message, and nothing on the
 * phone changes unless the restore itself succeeded.
 */
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn() }));
jest.mock("../services/sync/driveSync", () => ({ restoreFromDrive: jest.fn() }));

import { RecoveryCodeIncorrectError } from "../services/backup/backupErrors";
import { restoreWithRecoveryCode } from "../services/sync/codeRestore";

const RESULT = { restoredCount: 2, restoredToDoCount: 0, message: "Restored 2 notes from your backup of Oct 15, 2026." };

it("the correct code restores", async () => {
  const restore = jest.fn(async () => RESULT);
  await expect(restoreWithRecoveryCode("CODE", restore)).resolves.toEqual({ kind: "restored", result: RESULT });
  expect(restore).toHaveBeenCalledWith({ recoveryCode: "CODE" });
});

it("a wrong code says so and changes nothing", async () => {
  const restore = jest.fn(async () => {
    throw new RecoveryCodeIncorrectError();
  });
  const outcome = await restoreWithRecoveryCode("WRONG", restore);
  expect(outcome).toEqual({ kind: "wrongCode", message: expect.stringMatching(/doesn't unlock this backup.*Nothing was changed/) });
});

it("a failed restore shows a plain message, never raw text", async () => {
  const restore = jest.fn(async () => {
    throw new Error('fetch failed: java.net.UnknownHostException: Unable to resolve host "www.googleapis.com"');
  });
  const outcome = await restoreWithRecoveryCode("CODE", restore);
  expect(outcome.kind).toBe("failed");
  expect(outcome.kind !== "restored" && outcome.message).toMatch(/couldn't reach Google.*Nothing was changed\./);
  expect(outcome.kind !== "restored" && outcome.message).not.toMatch(/java|fetch failed/);
});
