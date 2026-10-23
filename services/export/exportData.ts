/**
 * "Export my notes": one plain-text file of every note and to-do, written
 * straight to a folder the user picks with Android's own folder picker
 * (Storage Access Framework). Started only by the user; never sent anywhere,
 * and no copy is left in the app's own storage — the text goes from the
 * vault directly into the chosen file. Free whatever the subscription status
 * (services/billing/ never gates it). The file is NOT encrypted; the screen
 * says so before anything is written.
 *
 * Never logs note or to-do text (counts only).
 */
import * as FileSystem from "expo-file-system/legacy";

import { listNotes, type Note } from "../notes/noteManager";
import { listAllToDos, type ToDo } from "../todos/todoManager";

export type ExportResult = { kind: "saved"; notes: number; todos: number } | { kind: "cancelled" } | { kind: "failed" };

const pad = (n: number) => String(n).padStart(2, "0");

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDateTime(d: Date): string {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const RECURRENCE_WORD: Record<string, string> = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };

function todoLine(todo: ToDo): string {
  const status = todo.isCompleted ? "[x]" : "[ ]";
  const when = todo.toDate ? `${todo.actionDate} to ${todo.toDate}` : todo.actionDate;
  const word = RECURRENCE_WORD[todo.recurrence];
  const repeat = word ? `, repeats every ${todo.recurrenceInterval > 1 ? `${todo.recurrenceInterval} ${word}s` : word}` : "";
  return `${status} ${todo.text} (${when} at ${todo.notificationTime}${repeat})`;
}

/** The file's text: notes newest first, then to-dos — pure. */
export function formatExport(notes: Pick<Note, "content" | "transcript" | "createdAt">[], todos: ToDo[], exportedAt: Date): string {
  const lines: string[] = [
    "Xayra export",
    `Created ${localDateTime(exportedAt)}. This file is not encrypted.`,
    "",
    `NOTES (${notes.length})`,
    "",
  ];
  const sorted = [...notes].sort((a, b) => b.createdAt - a.createdAt);
  for (const note of sorted) {
    lines.push(localDateTime(new Date(note.createdAt * 1000)));
    lines.push((note.content || note.transcript || "").trim());
    lines.push("");
  }
  lines.push(`TO-DOS (${todos.length})`, "");
  for (const todo of [...todos].sort((a, b) => a.actionDate.localeCompare(b.actionDate))) lines.push(todoLine(todo));
  return `${lines.join("\n").trimEnd()}\n`;
}

export function exportFileName(now: Date): string {
  return `Xayra export ${localDate(now)}`;
}

/**
 * Asks for a folder, then writes the file there. Cancelling the picker
 * writes nothing. A failure after the file was created removes that file
 * rather than leaving a partial copy.
 */
export async function exportToChosenFolder(now: Date = new Date()): Promise<ExportResult> {
  const saf = FileSystem.StorageAccessFramework;
  const permission = await saf.requestDirectoryPermissionsAsync();
  if (!permission.granted) return { kind: "cancelled" };
  let fileUri: string | null = null;
  try {
    const [notes, todos] = await Promise.all([listNotes(), listAllToDos()]);
    fileUri = await saf.createFileAsync(permission.directoryUri, exportFileName(now), "text/plain");
    await FileSystem.writeAsStringAsync(fileUri, formatExport(notes, todos, now));
    return { kind: "saved", notes: notes.length, todos: todos.length };
  } catch {
    if (fileUri) await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
    return { kind: "failed" };
  }
}
