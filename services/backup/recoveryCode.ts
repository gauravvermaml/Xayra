import * as Crypto from "expo-crypto";

/**
 * Extra Privacy recovery codes.
 *
 * - 26 random Crockford-base32 characters = 130 bits from the platform CSPRNG
 *   (expo-crypto), plus 2 check characters (the first 10 bits of SHA-256 of
 *   the data characters) that catch typos before any key derivation.
 * - Shown as 7 groups of 4: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.
 * - Users never choose it. It's never stored, logged or uploaded; the only
 *   place it exists outside the user's own copies is in memory while a flow
 *   that needs it is on screen. It's used as a SQLCipher passphrase
 *   (PBKDF2-HMAC-SHA512), so knowing it opens what it protects and nothing
 *   else is ever derived from it here.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const DATA_CHARS = 26;
const CHECK_CHARS = 2;
export const RECOVERY_CODE_GROUPS = 7;
const GROUP = 4;

function toBase32(bytes: Uint8Array, chars: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

async function checkChars(data: string): Promise<string> {
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `xayra-recovery-code:${data}`);
  const tenBits = parseInt(hex.slice(0, 3), 16) >> 2;
  return ALPHABET[(tenBits >> 5) & 31] + ALPHABET[tenBits & 31];
}

/** A new code, normalised (no dashes): 28 characters. */
export async function generateRecoveryCode(): Promise<string> {
  const random = await Crypto.getRandomBytesAsync(17); // 136 bits; 130 used
  const data = toBase32(random, DATA_CHARS);
  if (data.length !== DATA_CHARS) {
    throw new Error("Couldn't generate a recovery code.");
  }
  return data + (await checkChars(data));
}

/** XXXX-XXXX-… for display. */
export function formatRecoveryCode(code: string): string {
  return (code.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? []).join("-");
}

export function recoveryCodeGroups(code: string): string[] {
  return code.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? [];
}

/** Uppercases, drops spaces/dashes, and maps the look-alikes Crockford
 * defines (O→0, I/L→1). Returns null for anything else that isn't a code. */
export function normalizeRecoveryCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== DATA_CHARS + CHECK_CHARS) return null;
  for (const char of cleaned) {
    if (!ALPHABET.includes(char)) return null;
  }
  return cleaned;
}

/** Normalises and checks the typo-detection characters. */
export async function parseRecoveryCode(input: string): Promise<string | null> {
  const code = normalizeRecoveryCode(input);
  if (!code) return null;
  const data = code.slice(0, DATA_CHARS);
  return (await checkChars(data)) === code.slice(DATA_CHARS) ? code : null;
}

/** Two distinct group positions (0-based) to ask the user to confirm. */
export async function pickConfirmationGroups(): Promise<[number, number]> {
  const bytes = await Crypto.getRandomBytesAsync(2);
  const first = bytes[0] % RECOVERY_CODE_GROUPS;
  let second = bytes[1] % (RECOVERY_CODE_GROUPS - 1);
  if (second >= first) second += 1;
  return first < second ? [first, second] : [second, first];
}
