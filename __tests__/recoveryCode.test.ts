/**
 * Extra Privacy recovery codes (services/backup/recoveryCode.ts): entropy,
 * format, typo detection and normalisation.
 */
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_a: string, text: string) => require("crypto").createHash("sha256").update(text).digest("hex"),
  getRandomBytesAsync: async (n: number) => new Uint8Array(require("crypto").randomBytes(n)),
}));

import {
  formatRecoveryCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
  parseRecoveryCode,
  pickConfirmationGroups,
  recoveryCodeGroups,
} from "../services/backup/recoveryCode";

it("generates 28 Crockford characters (26 random = 130 bits, 2 check), shown as 7 groups of 4", async () => {
  const code = await generateRecoveryCode();
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{28}$/);
  expect(formatRecoveryCode(code)).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);
  expect(recoveryCodeGroups(code)).toHaveLength(7);
  expect(await parseRecoveryCode(code)).toBe(code);
});

it("codes don't repeat", async () => {
  const codes = new Set(await Promise.all(Array.from({ length: 200 }, () => generateRecoveryCode())));
  expect(codes.size).toBe(200);
});

it("accepts lowercase, spaces, dashes and Crockford look-alikes (O→0, I/L→1)", async () => {
  const code = await generateRecoveryCode();
  const messy = formatRecoveryCode(code).toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
  expect(await parseRecoveryCode(messy)).toBe(code);
});

it("catches a single wrong character, a swapped pair and wrong lengths", async () => {
  let caught = 0;
  const trials = 200;
  for (let i = 0; i < trials; i += 1) {
    const code = await generateRecoveryCode();
    const pos = i % 26;
    const replacement = code[pos] === "A" ? "B" : "A";
    if ((await parseRecoveryCode(code.slice(0, pos) + replacement + code.slice(pos + 1))) === null) caught += 1;
  }
  expect(caught).toBeGreaterThan(trials * 0.98); // 10-bit check: ~1/1024 miss rate
  const code = await generateRecoveryCode();
  expect(await parseRecoveryCode(code.slice(0, 27))).toBeNull();
  expect(normalizeRecoveryCode(`${code}A`)).toBeNull();
  expect(normalizeRecoveryCode(code.replace(/^./, "U"))).toBeNull();
});

it("picks two distinct groups to confirm", async () => {
  for (let i = 0; i < 100; i += 1) {
    const [a, b] = await pickConfirmationGroups();
    expect(a).toBeLessThan(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(7);
  }
});
