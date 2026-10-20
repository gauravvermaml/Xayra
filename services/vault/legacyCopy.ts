import { File } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";

import { getRawDatabase } from "../../db/client";
import { LEGACY_DATABASE_NAME, LEGACY_SIDE_FILE_SUFFIXES, legacyVaultDirectoryPath, readVaultFacts } from "./vaultActivation";

/**
 * The old unencrypted database left behind by the migration to the encrypted
 * vault (databases/silent-confidant.sqlite and its side files). The migration
 * only ever reads it, and keeps it until the user chooses to remove it here.
 *
 * Only that known file set is ever removed: never the encrypted vault, its
 * pointer, journal, escrow or keys, and nothing in Google Drive. Removal is
 * an ordinary file deletion; it isn't a guaranteed (forensic) erase of the
 * storage underneath, and the copy says so.
 */

export type LegacyCopyStatus = { present: boolean; bytes: number };

/** What the encrypted vault doesn't hold of the old copy (notes deleted
 * since the update, typically). Counts only — never content. */
export type LegacyCoverage = { missingNotes: number; missingTodos: number };

export type LegacyRemoval = { removed: string[]; failed: string[] };

function legacyFileNames(): string[] {
  return [LEGACY_DATABASE_NAME, ...LEGACY_SIDE_FILE_SUFFIXES.map((suffix) => `${LEGACY_DATABASE_NAME}${suffix}`)];
}

async function existingLegacyFiles(): Promise<{ name: string; size: number }[]> {
  const dir = legacyVaultDirectoryPath();
  const out: { name: string; size: number }[] = [];
  for (const name of legacyFileNames()) {
    const info = await FileSystem.getInfoAsync(`file://${dir}${name}`);
    if (info.exists && !info.isDirectory) out.push({ name, size: info.size ?? 0 });
  }
  return out;
}

/** Present only once the encrypted vault is committed and in use — before
 * that, the old database is still the source of a migration. */
export async function getLegacyCopyStatus(): Promise<LegacyCopyStatus> {
  const facts = await readVaultFacts();
  if (facts.pointer !== "valid" || facts.vault !== "encrypted") return { present: false, bytes: 0 };
  const files = await existingLegacyFiles();
  return { present: files.length > 0, bytes: files.reduce((sum, f) => sum + f.size, 0) };
}

/**
 * Checks the encrypted vault (integrity) and compares it with the old copy:
 * how many of the old copy's notes and to-dos the vault doesn't hold. The old
 * file is only read (attached with no key, SELECTs only, then detached).
 */
export async function checkVaultAgainstLegacy(): Promise<LegacyCoverage> {
  const status = await getLegacyCopyStatus();
  if (!status.present) throw new Error("There's no old copy to check.");
  const db = await getRawDatabase();
  const check = (await db.execute("PRAGMA main.quick_check")).rows ?? [];
  if (String(check[0]?.quick_check ?? Object.values(check[0] ?? {})[0] ?? "") !== "ok") {
    throw new Error("Your encrypted notes didn't pass their integrity check, so the old copy was kept.");
  }
  // Plaintext (empty key), the same way the migration's verification reads
  // its copy; only SELECTs run against it.
  await db.execute("ATTACH DATABASE ? AS legacy KEY ''", [`${legacyVaultDirectoryPath()}${LEGACY_DATABASE_NAME}`]);
  try {
    const missing = async (table: string): Promise<number> => {
      const exists = (await db.execute("SELECT count(*) AS n FROM legacy.sqlite_master WHERE type = 'table' AND name = ?", [table])).rows ?? [];
      if (Number(exists[0]?.n ?? 0) === 0) return 0;
      const rows = (await db.execute(`SELECT count(*) AS n FROM legacy.${table} WHERE id NOT IN (SELECT id FROM main.${table})`)).rows ?? [];
      return Number(rows[0]?.n ?? 0);
    };
    return { missingNotes: await missing("notes"), missingTodos: await missing("todos") };
  } finally {
    await db.execute("DETACH DATABASE legacy");
  }
}

/** Removes the old copy's files, each on its own, and reports exactly which
 * were removed and which weren't (re-checked afterwards). */
export async function removeLegacyCopy(): Promise<LegacyRemoval> {
  const status = await getLegacyCopyStatus();
  if (!status.present) return { removed: [], failed: [] };
  const dir = legacyVaultDirectoryPath();
  const result: LegacyRemoval = { removed: [], failed: [] };
  for (const file of await existingLegacyFiles()) {
    const target = `file://${dir}${file.name}`;
    try {
      // The newer File API: the legacy deleteAsync checks write access on
      // "<file>/..", which Android always denies outside files/ and cache/
      // (the old database lives in databases/).
      new File(target).delete();
    } catch {
      // Re-checked below.
    }
    const still = await FileSystem.getInfoAsync(target);
    (still.exists ? result.failed : result.removed).push(file.name);
  }
  return result;
}
