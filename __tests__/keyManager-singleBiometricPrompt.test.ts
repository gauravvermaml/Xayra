/**
 * QA Phase 3, Agent 4 test backlog item 6 (qa/04-test-strategy-report.md):
 * locks in the Build 38 double-biometric-prompt fix
 * (services/crypto/keyManager.ts's `readOrCreateKey`) — this used to ALSO
 * call `LocalAuthentication.authenticateAsync()` before ever touching
 * SecureStore, on top of the biometric prompt `requireAuthentication: true`
 * already triggers at the OS/Keystore level, forcing a user to unlock TWICE
 * for one database-key access. The fix removed the redundant explicit call
 * entirely — this test locks in that it's never called again, and that the
 * SecureStore access itself is still correctly gated exactly once.
 */
const mockHasHardwareAsync = jest.fn(() => Promise.resolve(true));
const mockIsEnrolledAsync = jest.fn(() => Promise.resolve(true));
const mockAuthenticateAsync = jest.fn(() => Promise.resolve({ success: true }));
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: mockHasHardwareAsync,
  isEnrolledAsync: mockIsEnrolledAsync,
  authenticateAsync: mockAuthenticateAsync,
}));

const mockGetItemAsync = jest.fn((_key: string, _options?: unknown) => Promise.resolve<string | null>(null));
const mockSetItemAsync = jest.fn((_key: string, _value: string, _options?: unknown) => Promise.resolve());
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: mockGetItemAsync,
  setItemAsync: mockSetItemAsync,
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("expo-crypto", () => ({
  getRandomBytesAsync: jest.fn(() => Promise.resolve(new Uint8Array(32).fill(7))),
  getRandomBytes: jest.fn(() => new Uint8Array(32).fill(7)),
}));

// Plain `require`, not a top-level `import` — an ES `import` declaration is
// hoisted above ALL other top-level code (including the `const mockX = ...`
// assignments above), which would run this module's top-level
// `SecureStore.getItemAsync` etc. lookups against a still-unassigned
// (`undefined`) mock before those consts ever executed.
const { getOrCreateDatabaseKey } = require("../services/crypto/keyManager");

describe("getOrCreateDatabaseKey triggers exactly one biometric gate, never a separate prompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    mockGetItemAsync.mockResolvedValue(null);
  });

  it("first call (key doesn't exist yet): reads then writes SecureStore with requireAuthentication, and never calls authenticateAsync directly", async () => {
    await getOrCreateDatabaseKey();

    expect(mockGetItemAsync).toHaveBeenCalledTimes(1);
    expect(mockGetItemAsync.mock.calls[0][1]).toMatchObject({ requireAuthentication: true });
    expect(mockSetItemAsync).toHaveBeenCalledTimes(1);
    expect(mockSetItemAsync.mock.calls[0][2]).toMatchObject({ requireAuthentication: true });
    // The Build 38 regression: a second, fully redundant explicit prompt on
    // top of the one requireAuthentication already triggers.
    expect(mockAuthenticateAsync).not.toHaveBeenCalled();
  });

  it("subsequent call (key already exists): one gated read, no write, still no separate prompt", async () => {
    mockGetItemAsync.mockResolvedValue("existing-key-hex");

    const key = await getOrCreateDatabaseKey();

    expect(key).toBe("existing-key-hex");
    expect(mockGetItemAsync).toHaveBeenCalledTimes(1);
    expect(mockSetItemAsync).not.toHaveBeenCalled();
    expect(mockAuthenticateAsync).not.toHaveBeenCalled();
  });

  it("when nothing is enrolled, SecureStore is accessed without the authentication gate at all (no prompt of any kind)", async () => {
    mockHasHardwareAsync.mockResolvedValue(false);
    mockIsEnrolledAsync.mockResolvedValue(false);

    await getOrCreateDatabaseKey();

    expect(mockGetItemAsync.mock.calls[0][1]).not.toMatchObject({ requireAuthentication: true });
    expect(mockAuthenticateAsync).not.toHaveBeenCalled();
  });
});
