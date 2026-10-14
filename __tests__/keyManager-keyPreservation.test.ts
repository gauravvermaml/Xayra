/**
 * Key preservation under every failure path (services/crypto/keyManager.ts):
 * an unlock attempt may read the stored key or report why it couldn't — it
 * never deletes, overwrites or regenerates it, and it never substitutes an
 * ephemeral key for an existing vault.
 */
const mockHasHardwareAsync = jest.fn(() => Promise.resolve(true));
const mockIsEnrolledAsync = jest.fn(() => Promise.resolve(true));
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: mockHasHardwareAsync,
  isEnrolledAsync: mockIsEnrolledAsync,
  authenticateAsync: jest.fn(),
}));

const mockGetItemAsync = jest.fn((_key: string, _options?: unknown) => Promise.resolve<string | null>(null));
const mockSetItemAsync = jest.fn((_key: string, _value: string, _options?: unknown) => Promise.resolve());
const mockDeleteItemAsync = jest.fn((_key: string, _options?: unknown) => Promise.resolve());
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: mockGetItemAsync,
  setItemAsync: mockSetItemAsync,
  deleteItemAsync: mockDeleteItemAsync,
}));

jest.mock("expo-crypto", () => ({
  getRandomBytesAsync: jest.fn(() => Promise.resolve(new Uint8Array(32).fill(7))),
  getRandomBytes: jest.fn(() => new Uint8Array(32).fill(9)),
}));

const { getOrCreateDatabaseKey, AuthenticationFailedError, DatabaseKeyError } = require("../services/crypto/keyManager");
const { vaultLockReasonFor } = require("../services/crypto/vaultLockState");

function nativeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
const CANCELLED = nativeError("ERR_AUTHENTICATION", "Could not Authenticate the user: User canceled the authentication. Cancel");
const SYSTEM_CANCELLED = nativeError("ERR_AUTHENTICATION", "Could not Authenticate the user: Unknown error (code: 5). Canceled");
const TIMEOUT = nativeError("ERR_AUTHENTICATION", "Could not Authenticate the user: Timeout. Timed out");
const LOCKOUT = nativeError("ERR_AUTHENTICATION", "Could not Authenticate the user: Lockout. Too many attempts");
const LOCKOUT_PERMANENT = nativeError("ERR_AUTHENTICATION", "Could not Authenticate the user: Lockout permanent. Disabled");
const UNKNOWN_AUTH = nativeError("ERR_AUTHENTICATION", "Could not Authenticate the user: Unknown error (code: 42). ?");
const DECRYPT = nativeError("ERR_DECRYPT", "Could not decrypt the value for key 'silent-confidant.db-encryption-key'");

function expectKeyUntouched(): void {
  expect(mockSetItemAsync).not.toHaveBeenCalled();
  expect(mockDeleteItemAsync).not.toHaveBeenCalled();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("getOrCreateDatabaseKey preserves the stored key on every failure path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    mockGetItemAsync.mockResolvedValue(null);
    mockSetItemAsync.mockResolvedValue(undefined);
  });

  it.each([
    [CANCELLED, "userCancelled"],
    [SYSTEM_CANCELLED, "systemCancelled"],
    [TIMEOUT, "timeout"],
    [LOCKOUT, "lockout"],
    [LOCKOUT_PERMANENT, "lockoutPermanent"],
  ])("authentication outcome %#: typed reason, key untouched", async (error, reason) => {
    mockGetItemAsync.mockRejectedValue(error);
    const err = await rejection(getOrCreateDatabaseKey());
    expect(err).toBeInstanceOf(AuthenticationFailedError);
    expect(vaultLockReasonFor(err)).toBe(reason);
    expectKeyUntouched();
  });

  it.each([
    ["unknown authentication result", UNKNOWN_AUTH],
    ["decrypt failure", DECRYPT],
    ["error without code or message", {}],
    ["undefined rejection", undefined],
  ])("%s: keyUnavailable, never 'cancelled', key untouched", async (_label, error) => {
    mockGetItemAsync.mockRejectedValue(error);
    const err = await rejection(getOrCreateDatabaseKey());
    expect(err).toBeInstanceOf(DatabaseKeyError);
    expect(vaultLockReasonFor(err)).toBe("keyUnavailable");
    expectKeyUntouched();
  });

  it("existing vault but SecureStore returns no key (invalidated/out of sync): keyMissing, nothing minted", async () => {
    mockGetItemAsync.mockResolvedValue(null);
    const err = await rejection(getOrCreateDatabaseKey({ allowCreate: false }));
    expect(vaultLockReasonFor(err)).toBe("keyMissing");
    expectKeyUntouched();
  });

  it("the default is read-only: no key is minted unless the caller opts in", async () => {
    mockGetItemAsync.mockResolvedValue(null);
    await rejection(getOrCreateDatabaseKey());
    expectKeyUntouched();
  });

  it("first run (no vault): a key is created once, gated by biometrics", async () => {
    const key = await getOrCreateDatabaseKey({ allowCreate: true });
    expect(key).toBe("07".repeat(32));
    expect(mockSetItemAsync).toHaveBeenCalledTimes(1);
    expect(mockSetItemAsync.mock.calls[0][2]).toMatchObject({ requireAuthentication: true });
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
  });

  it("first run cancelled while storing the new key: typed cancellation, nothing deleted", async () => {
    mockSetItemAsync.mockRejectedValue(CANCELLED);
    const err = await rejection(getOrCreateDatabaseKey({ allowCreate: true }));
    expect(vaultLockReasonFor(err)).toBe("userCancelled");
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
  });

  it("auth outcomes are classified even if availability was misreported (stored item still prompts)", async () => {
    mockIsEnrolledAsync.mockRejectedValue(new Error("transient"));
    mockGetItemAsync.mockRejectedValue(CANCELLED);
    const err = await rejection(getOrCreateDatabaseKey({ allowCreate: false }));
    expect(vaultLockReasonFor(err)).toBe("userCancelled");
    expectKeyUntouched();
  });

  describe("no biometrics enrolled (existing policy: keystore-encrypted, no prompt)", () => {
    beforeEach(() => {
      mockHasHardwareAsync.mockResolvedValue(false);
      mockIsEnrolledAsync.mockResolvedValue(false);
    });

    it("reads the existing key without requireAuthentication", async () => {
      mockGetItemAsync.mockResolvedValue("existing-key-hex");
      expect(await getOrCreateDatabaseKey()).toBe("existing-key-hex");
      expect(mockGetItemAsync.mock.calls[0][1]).not.toMatchObject({ requireAuthentication: true });
    });

    it("existing vault + broken SecureStore: surfaces keyUnavailable, never an ephemeral key", async () => {
      mockGetItemAsync.mockRejectedValue(nativeError("ERR_KEY_STORE", "keystore broken"));
      const err = await rejection(getOrCreateDatabaseKey({ allowCreate: false }));
      expect(vaultLockReasonFor(err)).toBe("keyUnavailable");
      expectKeyUntouched();
    });

    it("first run + broken SecureStore read: keyUnavailable — never an in-memory key", async () => {
      mockGetItemAsync.mockRejectedValue(nativeError("ERR_KEY_STORE", "keystore broken"));
      const err = await rejection(getOrCreateDatabaseKey({ allowCreate: true }));
      expect(vaultLockReasonFor(err)).toBe("keyUnavailable");
      expectKeyUntouched();
    });

    it("first run + key can't be stored: keyUnavailable — the unstored key is never returned", async () => {
      mockSetItemAsync.mockRejectedValue(nativeError("ERR_WRITE", "An error occurred when writing to key"));
      const err = await rejection(getOrCreateDatabaseKey({ allowCreate: true }));
      expect(vaultLockReasonFor(err)).toBe("keyUnavailable");
      expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    });
  });

  describe("persistent keys only — no in-memory fallback (production and normal Xayra Dev)", () => {
    it("with biometrics, a key that can't be stored is never returned", async () => {
      mockSetItemAsync.mockRejectedValue(nativeError("ERR_ENCRYPT", "Could not encrypt the value"));
      const err = await rejection(getOrCreateDatabaseKey({ allowCreate: true }));
      expect(vaultLockReasonFor(err)).toBe("keyUnavailable");
      expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    });

    it("an unexpected error while generating the key is a recoverable keyUnavailable, nothing stored", async () => {
      const Crypto = require("expo-crypto");
      Crypto.getRandomBytesAsync.mockRejectedValueOnce(new Error("entropy source unavailable"));
      const err = await rejection(getOrCreateDatabaseKey({ allowCreate: true }));
      expect(vaultLockReasonFor(err)).toBe("keyUnavailable");
      expectKeyUntouched();
    });

    it("an unknown thrown value while storing is still keyUnavailable", async () => {
      mockSetItemAsync.mockRejectedValue(undefined);
      const err = await rejection(getOrCreateDatabaseKey({ allowCreate: true }));
      expect(vaultLockReasonFor(err)).toBe("keyUnavailable");
    });

    it("keyManager has no in-memory key path and knows nothing about disposable vaults", () => {
      const source: string = require("fs").readFileSync(
        require("path").join(__dirname, "..", "services", "crypto", "keyManager.ts"),
        "utf8"
      );
      expect(source).not.toMatch(/ephemeral/i);
      expect(source).not.toMatch(/getRandomBytes\(/); // the old synchronous in-memory key
      expect(source).not.toMatch(/from "\.\.\/dev\//);
    });
  });
});

describe("vaultLockReasonFor", () => {
  it("anything keyManager didn't type is a database failure, never an authentication one", () => {
    expect(vaultLockReasonFor(new Error("sqlite query error: file is not a database"))).toBe("databaseError");
    expect(vaultLockReasonFor(CANCELLED)).toBe("databaseError"); // raw, unclassified native error
    expect(vaultLockReasonFor(undefined)).toBe("databaseError");
  });
});

describe("singleFlight (Unlock taps)", () => {
  const { singleFlight } = require("../services/crypto/vaultLockState");

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("rapid taps start exactly one attempt; the rest are refused", async () => {
    const pending = deferred<boolean>();
    const attempt = jest.fn(() => pending.promise);
    const run = singleFlight(attempt);
    const first = run();
    expect(run()).toBeNull();
    expect(run()).toBeNull();
    expect(attempt).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await expect(first).resolves.toBe(true);
  });

  it("after a cancelled (rejected) attempt, the next tap starts a fresh one", async () => {
    const first = deferred<boolean>();
    const attempt = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(true);
    const run = singleFlight(attempt);
    const running = run();
    first.reject(CANCELLED);
    await expect(running).rejects.toBe(CANCELLED);
    await expect(run()).resolves.toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("an attempt that throws synchronously does not wedge the gate", async () => {
    const attempt = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("sync failure");
      })
      .mockResolvedValueOnce(false);
    const run = singleFlight(attempt);
    await expect(run()).rejects.toThrow("sync failure");
    await expect(run()).resolves.toBe(false);
  });
});
