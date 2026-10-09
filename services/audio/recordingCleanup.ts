import * as FileSystem from "expo-file-system/legacy";

import { LEGACY_RECORDINGS_DIR, RECORDINGS_DIR } from "./wav";

export type RecordingCleanupResult = {
  /** Temporary recordings removed from the cache folder. */
  deletedTemporary: number;
  /** Unlinked WAVs removed from the old document-storage folder. */
  deletedLegacyOrphans: number;
  /** WAVs in the old folder kept because a note still links to them. */
  keptLinkedLegacy: number;
};

const isWav = (name: string) => name.toLowerCase().endsWith(".wav");
const baseName = (uri: string) => uri.split("/").pop() ?? uri;

/** Plain files in `dir` (missing folder = none). */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const names = await FileSystem.readDirectoryAsync(dir);
    const files: string[] = [];
    for (const name of names) {
      const info = await FileSystem.getInfoAsync(`${dir}${name}`);
      if (info.exists && !info.isDirectory) files.push(name);
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Launch-time safety net for input audio — Xayra keeps the TEXT note, not
 * the recording. A WAV normally lives only until it is transcribed and is
 * deleted right after (app/index.tsx's finishUtterance), but a process kill
 * between writing and deleting it would otherwise leave it forever.
 *
 *  - The cache folder only ever holds in-flight recordings, so at launch
 *    (before anything can be recording) every WAV there is stale.
 *  - The old document-storage folder may still hold audio that historical
 *    notes link to and play. A WAV there is deleted ONLY when no note's
 *    `audio_uri` names it. If the linked list can't be read, nothing there
 *    is deleted at all — this fails toward keeping files, never losing them.
 *
 * Only `.wav` files directly inside these two folders are touched: never
 * model files, the database, other caches or subfolders.
 */
export async function cleanupOrphanRecordings(listLinkedAudioUris: () => Promise<string[]>): Promise<RecordingCleanupResult> {
  const result: RecordingCleanupResult = { deletedTemporary: 0, deletedLegacyOrphans: 0, keptLinkedLegacy: 0 };

  for (const name of (await listFiles(RECORDINGS_DIR)).filter(isWav)) {
    await FileSystem.deleteAsync(`${RECORDINGS_DIR}${name}`, { idempotent: true }).catch(() => {});
    result.deletedTemporary += 1;
  }

  const legacy = (await listFiles(LEGACY_RECORDINGS_DIR)).filter(isWav);
  if (legacy.length === 0) return result;
  let linked: Set<string>;
  try {
    linked = new Set((await listLinkedAudioUris()).map(baseName));
  } catch (err) {
    console.warn("[Recordings] Couldn't read which notes link to audio — skipping old-folder cleanup.", err);
    return result;
  }
  for (const name of legacy) {
    if (linked.has(name)) {
      result.keptLinkedLegacy += 1;
      continue;
    }
    await FileSystem.deleteAsync(`${LEGACY_RECORDINGS_DIR}${name}`, { idempotent: true }).catch(() => {});
    result.deletedLegacyOrphans += 1;
  }
  return result;
}
