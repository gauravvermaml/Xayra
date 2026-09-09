import * as chrono from "chrono-node";

import { RECURRENCE_OPTIONS, type Recurrence } from "../../db/schema";
import { runQueuedLlamaCompletion } from "./localLlama";
import { logDuration, nowMs } from "./perf";

/** One task pulled out of a note's raw text by extractToDosFromText(). Shape
 * matches services/todos/todoManager.ts's `addToDo()` params 1:1 so the
 * caller (Phase 2's UI/save flow) can pass an item straight through. */
export type ExtractedToDo = {
  task: string;
  actionDate: string; // ISO YYYY-MM-DD
  recurrence: Recurrence;
};

/** Llama-3.2's instruct template stop marker — see localLlama.ts's own
 * EOT_TOKEN for why this has to be in `stop`. */
const EOT_TOKEN = "<|eot_id|>";

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayIso(): string {
  return formatIsoDate(new Date());
}

function parseIsoDateLocal(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Next calendar date landing on `dayOfMonth`, strictly after `from`. Rolls
 * to next month whenever `from`'s day-of-month has already reached
 * `dayOfMonth` this month. Used for the "the 1st"/"the 15th" style bare
 * day-of-month phrasing that chrono-node can't reliably resolve on its own
 * (see resolveActionDate's own comment for why this exists alongside it). */
function nextDayOfMonth(from: Date, dayOfMonth: number): Date {
  const candidate = new Date(from.getFullYear(), from.getMonth(), dayOfMonth);
  if (candidate <= from) {
    candidate.setMonth(candidate.getMonth() + 1);
  }
  return candidate;
}

/** Matches a bare day-of-month reference with no month attached — "the
 * 1st", "1st of every month", "on the 15th", "day 1" — the one common
 * phrasing chrono-node (see resolveActionDate) doesn't resolve to a sane
 * future date on its own (tested on-device: it either returns null or
 * silently adds a month while keeping today's day-of-month, e.g. "1st of
 * the month" from Sep 9 came back Oct 9, not Oct 1). */
const BARE_DAY_OF_MONTH_PATTERN = /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:am|pm|:))/i;

/**
 * Resolves the model's extracted natural-language date reference into a
 * concrete ISO date. This is the fix for a real on-device bug: the previous
 * version of this file asked the LLM to compute the absolute action_date
 * itself, and a 1B/3B instruct model is unreliable at date ARITHMETIC even
 * when it correctly understands the note's language — confirmed on-device,
 * "pay rent on the 1st of every month" (asked on Sep 9) came back as
 * "2026-11-01" (one month too far) despite the model correctly identifying
 * the task and recurrence.
 *
 * The fix moves arithmetic out of the model entirely: the model's only job
 * (see buildSystemPrompt) is to extract the literal date phrase as it
 * appears in the note (or "" if none is mentioned) — a much easier,
 * near-copy-paste extraction task — and this function resolves that phrase
 * deterministically:
 *  1. Empty phrase → today (no date was mentioned).
 *  2. A bare day-of-month with no month attached ("the 1st", "1st of every
 *     month") → nextDayOfMonth() above, since chrono-node doesn't handle
 *     this phrasing reliably on its own (tested — see BARE_DAY_OF_MONTH_PATTERN
 *     doc comment for the exact failures observed).
 *  3. Everything else (weekday names, "tomorrow", "March 3rd", full dates)
 *     → chrono-node's `parseDate` with `forwardDate: true`, which resolves
 *     an otherwise-past-implied date to its next future occurrence — exactly
 *     the "next upcoming occurrence" rule this module needs, and something
 *     chrono-node (a dedicated, battle-tested date-parsing library) is far
 *     more reliable at than a 1B language model doing arithmetic by "feel."
 *  4. Anything chrono-node can't parse at all → today, same safe fallback as
 *     an empty phrase, rather than leaving the to-do dateless.
 */
function resolveActionDate(datePhrase: string, todayISO: string): string {
  const trimmed = datePhrase.trim();
  if (!trimmed) {
    return todayISO;
  }

  const today = parseIsoDateLocal(todayISO);

  const bareDayMatch = trimmed.match(BARE_DAY_OF_MONTH_PATTERN);
  // Only treat this as a bare day-of-month if chrono itself finds no
  // parseable date in the phrase — a phrase like "March 3rd" also matches
  // the bare-day regex on its "3rd", but chrono correctly resolves the
  // whole "March 3rd" and should win.
  const chronoResult = chrono.parseDate(trimmed, today, { forwardDate: true });

  if (!chronoResult && bareDayMatch) {
    const day = Number(bareDayMatch[1]);
    if (day >= 1 && day <= 31) {
      return formatIsoDate(nextDayOfMonth(today, day));
    }
  }

  return chronoResult ? formatIsoDate(chronoResult) : todayISO;
}

/**
 * System prompt for structured extraction, not conversation — deliberately
 * far shorter and stricter than localLlama.ts's RAG SYSTEM_PROMPT, since the
 * only acceptable output here is a bare JSON array. The model's job is
 * deliberately limited to language understanding (what's the task, what date
 * phrase — if any — is attached to it, does it repeat) with zero date
 * arithmetic asked of it; resolveActionDate() above does all of the actual
 * date math afterward. Today's date is still given for context (recurrence
 * judgment and disambiguating relative task descriptions can use it), but
 * the model is explicitly told to copy the date phrase, not resolve it.
 */
function buildSystemPrompt(todayISO: string): string {
  return (
    "You are a task-extraction engine for a personal notes app. Read the note text the user " +
    "provides and extract every actionable to-do item mentioned in it — an actionable item is " +
    "something the user needs to DO, not just something they mentioned in passing.\n\n" +
    `Today's Date: ${todayISO}\n\n` +
    "Respond with ONLY a raw JSON array — no prose, no markdown code fences, no explanation before " +
    "or after it. Each element must be an object with exactly these three fields:\n" +
    '  "task": a short, clear description of the action item (string)\n' +
    '  "date_phrase": the date/time reference exactly as it appears in the note (e.g. "tomorrow", ' +
    '"next Friday", "the 1st of every month", "March 3rd") — or an empty string "" if the task has ' +
    "no date mentioned at all. Copy the phrase as written; do NOT calculate or convert it into a " +
    "calendar date yourself.\n" +
    '  "recurrence": one of "none", "daily", "weekly", or "monthly"\n\n' +
    "How to choose recurrence — match the task's OWN wording against this table, and nothing else:\n" +
    '  "every day" / "each day" / "daily"                          → "daily"\n' +
    '  "every Monday" / "every Friday night" / "every week" / "weekly" (ANY specific weekday,\n' +
    '  not just Monday, means it happens once every 7 days)         → "weekly"\n' +
    '  "every month" / "monthly" / "the 1st of every month"         → "monthly"\n' +
    "  no repeating words at all                                    → \"none\"\n\n" +
    "Rules:\n" +
    "- \"none\" is the default for every task. Only move off it when THAT task's own wording, read " +
    "on its own, clearly says it repeats — never because a different task in the same note repeats, " +
    "and never because an earlier example happened to use a non-\"none\" value. Judge every task by " +
    "its own words alone.\n" +
    "- A specific weekday (\"every Monday\", \"every Friday\") is WEEKLY, never daily — daily means " +
    "literally every single day, not once a week on a named day.\n" +
    "- Never invent a date phrase that isn't actually in the note — leave date_phrase empty instead.\n\n" +
    "If the note contains no actionable to-do items at all, respond with exactly: []"
  );
}

/**
 * Four fixed one-shot examples, injected as real prior user/assistant turns
 * — same technique localLlama.ts's RAG prompt already relies on (see its own
 * FEW_SHOT_* comment for why a demonstrated turn steers a small instruct
 * model far more reliably than the same instruction written as prose).
 *
 * Deliberately FOUR SEPARATE single-item turns rather than one combined
 * multi-item list (the original version of this fix). On-device testing
 * with the combined version found the model didn't apply per-item judgment
 * at all: a real 3-task note with no dates and no recurring language on any
 * task came back with task 1 correctly "none", but tasks 2 and 3 as "daily"
 * and "monthly" respectively — i.e. it seems to have pattern-matched the
 * combined example's fixed shape (item 2 always "monthly") rather than
 * reading each task's own words. Giving each recurrence value its own
 * dedicated turn removes that positional shape for the model to copy.
 *
 * The second entry below also directly demonstrates the exact on-device
 * miss that prompted this fix: "every Monday night" was previously
 * misclassified as "daily" — this turn shows that precise phrasing
 * resolved to "weekly" instead.
 */
const FEW_SHOT_EXAMPLES: { input: string; answer: string }[] = [
  {
    input: "Remind me to call the dentist tomorrow.",
    answer: JSON.stringify([{ task: "Call the dentist", date_phrase: "tomorrow", recurrence: "none" }]),
  },
  {
    input: "I need to put the bins out every Monday night.",
    answer: JSON.stringify([
      { task: "Put the bins out", date_phrase: "every Monday night", recurrence: "weekly" },
    ]),
  },
  {
    input: "Don't forget to pay the rent on the 1st of every month.",
    answer: JSON.stringify([
      { task: "Pay the rent", date_phrase: "the 1st of every month", recurrence: "monthly" },
    ]),
  },
  {
    input: "I should call mom.",
    answer: JSON.stringify([{ task: "Call mom", date_phrase: "", recurrence: "none" }]),
  },
];

function buildPrompt(rawText: string, todayISO: string): string {
  const fewShotTurns = FEW_SHOT_EXAMPLES.map(
    ({ input, answer }) =>
      "<|start_header_id|>user<|end_header_id|>\n\n" +
      `${input}${EOT_TOKEN}` +
      "<|start_header_id|>assistant<|end_header_id|>\n\n" +
      `${answer}${EOT_TOKEN}`
  ).join("");

  return (
    "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n" +
    `${buildSystemPrompt(todayISO)}${EOT_TOKEN}` +
    fewShotTurns +
    "<|start_header_id|>user<|end_header_id|>\n\n" +
    `${rawText}${EOT_TOKEN}` +
    "<|start_header_id|>assistant<|end_header_id|>\n\n"
  );
}

/**
 * Pulls the JSON array substring out of the model's raw completion. Small
 * instruct models frequently ignore the "ONLY a raw JSON array" instruction
 * and wrap it in a sentence ("Here's the list: [...]") or a markdown code
 * fence despite being told not to — slicing from the first "[" to the last
 * "]" recovers the array in both cases instead of failing the whole parse.
 */
function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON array found in model output.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function isRecurrence(value: unknown): value is Recurrence {
  return typeof value === "string" && (RECURRENCE_OPTIONS as readonly string[]).includes(value);
}

/**
 * Defensive structural normalization on top of whatever the on-device model
 * actually returns, plus deterministic date resolution via resolveActionDate
 * above. A 1B/3B instruct model is not reliable enough at strict JSON
 * schemas to trust its output verbatim — any entry missing a task, or
 * carrying a malformed recurrence, is either coerced to a safe default or
 * dropped entirely (an empty/missing task), rather than throwing and
 * discarding every other item the model got right.
 */
function normalizeExtracted(raw: unknown, todayISO: string): ExtractedToDo[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const results: ExtractedToDo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;

    const task = typeof record.task === "string" ? record.task.trim() : "";
    if (!task) {
      continue;
    }

    const datePhrase = typeof record.date_phrase === "string" ? record.date_phrase : "";
    const actionDate = resolveActionDate(datePhrase, todayISO);

    const recurrence: Recurrence = isRecurrence(record.recurrence) ? record.recurrence : "none";

    results.push({ task, actionDate, recurrence });
  }
  return results;
}

/**
 * Parses raw note text into structured to-do items entirely on-device, via
 * Xayra's existing llama.rn context (services/ai/localLlama.ts) — no network
 * call, no second model loaded into memory alongside the RAG one. Never
 * throws: a model that isn't downloaded yet, a malformed completion, or any
 * other failure resolves to an empty array rather than blocking whatever
 * caller is trying to save the underlying note.
 */
export async function extractToDosFromText(rawText: string): Promise<ExtractedToDo[]> {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return [];
  }

  const todayISO = todayIso();

  try {
    const prompt = buildPrompt(trimmed, todayISO);

    const start = nowMs();
    // Routed through localLlama.ts's shared completion queue, not a direct
    // context.completion() call — extraction and RAG answers share one
    // native llama.cpp context, which allows only one in-flight completion
    // at a time. Several notes saved in quick succession used to fire
    // several of these concurrently and silently lose every one but the
    // first to "context is busy" (see runQueuedLlamaCompletion's own doc
    // comment for the on-device repro).
    const result = await runQueuedLlamaCompletion({
      prompt,
      n_predict: 512,
      // Near-deterministic: this is structured extraction against a fixed
      // schema, not open-ended conversation, so the warmth/variety
      // localLlama.ts's RAG generation tunes for would only hurt here.
      temperature: 0.1,
      top_p: 0.9,
      stop: [EOT_TOKEN, "<|end_of_text|>"],
    });
    logDuration("Llama to-do extraction", start);

    const rawOutput = result.text.trim();
    try {
      const parsed = extractJsonArray(rawOutput);
      return normalizeExtracted(parsed, todayISO);
    } catch (parseErr) {
      // Logged separately from the outer catch (which also covers
      // getContext()/completion failures) specifically so a parse failure
      // shows the actual text that broke it — "no JSON array found" alone
      // isn't diagnosable on its own, and this is a 1B/3B model, so it will
      // happen again on some future input shape.
      console.warn(
        "[transformationEngine] Failed to parse to-do extraction output — skipping.",
        parseErr,
        "Raw output:",
        rawOutput.slice(0, 500)
      );
      return [];
    }
  } catch (err) {
    console.warn("[transformationEngine] To-do extraction unavailable — skipping.", err);
    return [];
  }
}
