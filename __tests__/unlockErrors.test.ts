import * as fs from "fs";
import * as path from "path";

import {
  classifyUnlockFailure,
  SECURE_STORE_AUTH_CODE,
  SECURE_STORE_AUTH_PREFIX,
  SECURE_STORE_AUTH_TYPES,
} from "../services/crypto/unlockErrors";

// What JS receives from expo-secure-store 57.x on Android: an Error with the
// Expo-generated `code` and the module-call wrapper around the native message.
function secureStoreError(code: string, nativeMessage: string): Error & { code: string } {
  const err = new Error(
    `Call to function 'ExpoSecureStore.getValueWithKeyAsync' has been rejected.\n→ Caused by: ${nativeMessage}`
  ) as Error & { code: string };
  err.code = code;
  return err;
}
const auth = (detail: string) => secureStoreError(SECURE_STORE_AUTH_CODE, `${SECURE_STORE_AUTH_PREFIX}${detail}`);

describe("classifyUnlockFailure — recognised authentication outcomes", () => {
  it.each([
    ["User canceled the authentication. Cancel", "userCancelled"],
    ["User canceled the authentication. Abbrechen", "userCancelled"], // localized errString
    ["Unknown error (code: 5). Fingerprint operation canceled.", "systemCancelled"],
    ["Cannot display biometric prompt when the app is not in the foreground", "systemCancelled"],
    ["Timeout. Fingerprint operation timed out.", "timeout"],
    ["Lockout. Too many attempts. Try again later.", "lockout"],
    ["Lockout permanent. Too many attempts. Fingerprint sensor disabled.", "lockoutPermanent"],
    ["Lockout. ", "lockout"], // empty errString
  ])("%s → %s", (detail, expected) => {
    expect(classifyUnlockFailure(auth(detail))).toBe(expected);
  });

  it("reads only the Expo-authored type, never the OEM/localized errString", () => {
    // errString mentions lockout and timeout words; the type says cancelled.
    expect(classifyUnlockFailure(auth("User canceled the authentication. Lockout. Timeout."))).toBe("userCancelled");
    // ...and the reverse: a cancel-looking errString can't upgrade a lockout.
    expect(classifyUnlockFailure(auth("Lockout. User canceled the authentication"))).toBe("lockout");
  });

  it("classifies by message when the structured code is absent (older bridge)", () => {
    expect(classifyUnlockFailure(new Error(`${SECURE_STORE_AUTH_PREFIX}User canceled the authentication. Cancel`))).toBe(
      "userCancelled"
    );
  });
});

describe("classifyUnlockFailure — everything else is not an authentication outcome", () => {
  it.each([
    "Unknown error (code: 15). Security update required", // unmapped BiometricPrompt code
    "Unknown error (code: 99). ", // future BiometricPrompt code
    "Hardware unavailable. Sensor busy",
    "Unable to process. Try again",
    "Vendor error. OEM specific",
    "No biometrics enrolled. No fingerprints",
    "Authentication is already in progress",
    "Couldn't get the authentication result",
    "Biometric prompt was dismissed", // hypothetical future rewording
    "",
  ])("unknown auth type %p → null", (detail) => {
    expect(classifyUnlockFailure(auth(detail))).toBeNull();
  });

  it("a structured non-auth code wins over an auth-looking message", () => {
    expect(
      classifyUnlockFailure(secureStoreError("ERR_DECRYPT", `${SECURE_STORE_AUTH_PREFIX}User canceled the authentication. x`))
    ).toBeNull();
    expect(classifyUnlockFailure(secureStoreError("ERR_KEY_STORE", "An error occurred when accessing the keystore"))).toBeNull();
  });

  it("an ERR_AUTHENTICATION code with an unfamiliar message format → null", () => {
    expect(classifyUnlockFailure(secureStoreError(SECURE_STORE_AUTH_CODE, "User canceled"))).toBeNull();
    expect(classifyUnlockFailure(secureStoreError(SECURE_STORE_AUTH_CODE, "Authentication failed: CANCELED"))).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty object", {}],
    ["empty Error", new Error("")],
    ["number", 42],
    ["plain string without the prefix", "cancelled"],
    ["object with non-string message", { message: 7, code: SECURE_STORE_AUTH_CODE }],
    ["SQLCipher open failure", new Error("sqlite query error: file is not a database")],
  ])("missing or foreign details (%s) → null", (_label, value) => {
    expect(classifyUnlockFailure(value)).toBeNull();
  });
});

/**
 * Drift canary: the strings above are Expo's, not Android's. If an
 * expo-secure-store upgrade rewords or remaps them, fail here — at upgrade
 * time — rather than silently turning cancellations into errors (or worse).
 */
describe("matched strings still exist in the installed expo-secure-store", () => {
  const dir = path.join(
    __dirname,
    "..",
    "node_modules",
    "expo-secure-store",
    "android",
    "src",
    "main",
    "java",
    "expo",
    "modules",
    "securestore"
  );
  const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");
  const prompt = read("AuthenticationPrompt.kt");
  const helper = read("AuthenticationHelper.kt");
  const exceptions = read("SecureStoreExceptions.kt");

  it("AuthenticationException keeps its class name (→ ERR_AUTHENTICATION) and prefix", () => {
    expect(exceptions).toMatch(/class AuthenticationException\(/);
    expect(exceptions).toContain(`CodedException("${SECURE_STORE_AUTH_PREFIX}$`);
  });

  it("prompt errors are still formatted as \"<type>. <errString>\"", () => {
    expect(prompt).toContain('val message = "$errorType. $errString"');
  });

  it("every mapped type is still emitted", () => {
    const fixedTypes = Object.keys(SECURE_STORE_AUTH_TYPES).filter((type) => type !== "Unknown error (code: 5)");
    for (const type of fixedTypes) {
      expect(`${prompt}\n${helper}`).toContain(`"${type}"`);
    }
  });

  it("ERROR_CANCELED (5) is still unmapped, so it still arrives as \"Unknown error (code: 5)\"", () => {
    expect(prompt).not.toMatch(/ERROR_CANCELED\s*->/);
    expect(prompt).toContain('else -> "Unknown error (code: $code)"');
  });
});
