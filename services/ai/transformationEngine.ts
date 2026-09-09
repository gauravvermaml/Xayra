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

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayIso(): string {
  return formatIsoDate(new Date());
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Next calendar date landing on `dayOfMonth`, strictly after `from` — used
 * only to build the worked example below (buildFewShotAnswer), never for
 * real extraction (the model resolves those dates itself). Rolls to next
 * month whenever `from`'s day-of-month has already reached `dayOfMonth`. */
function nextDayOfMonth(from: Date, dayOfMonth: number): Date {
  const candidate = new Date(from.getFullYear(), from.getMonth(), dayOfMonth);
  if (candidate <= from) {
    candidate.setMonth(candidate.getMonth() + 1);
  }
  return candidate;
}

/**
 * System prompt for structured extraction, not conversation — deliberately
 * far shorter and stricter than localLlama.ts's RAG SYSTEM_PROMPT, since the
 * only acceptable output here is a bare JSON array. Today's date is baked in
 * fresh on every call (never memoized) so a task extracted at 11:58pm and one
 * extracted a minute later never disagree about what day "today" was.
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
    '  "action_date": the date the task should happen, as an ISO date in YYYY-MM-DD format\n' +
    '  "recurrence": one of "none", "daily", "weekly", or "monthly"\n\n' +
    "Date rules:\n" +
    `- If a task has no date mentioned at all, set action_date to today's date (${todayISO}).\n` +
    "- If a task mentions a day or month without a year (e.g. \"March 3rd\", \"next Friday\", " +
    "\"the 12th\"), resolve it to the NEXT upcoming occurrence of that date relative to today — " +
    "never a date that has already passed.\n" +
    "- If a task describes something repeating (\"every day\", \"every Monday\", \"each week\", " +
    "\"monthly\"), set recurrence to the matching value and set action_date to the next occurrence " +
    "of it from today.\n" +
    "- A task with no repeating language must always have recurrence set to \"none\".\n\n" +
    "If the note contains no actionable to-do items at all, respond with exactly: []"
  );
}

const FEW_SHOT_INPUT =
  "Remind me to call the dentist tomorrow. Also need to pay the rent on the 1st of every month.";

/**
 * A fixed one-shot example, injected as a real prior user/assistant turn —
 * same technique localLlama.ts's RAG prompt already relies on (see its own
 * FEW_SHOT_* comment for why a demonstrated turn steers a small instruct
 * model far more reliably than the same instruction written as prose).
 * On-device testing found the bare system-prompt instructions above were not
 * enough on their own: a single short voice transcript ("remind me to call
 * the plumber tomorrow") produced a plain-prose reply with no JSON array at
 * all, which extractJsonArray then had nothing to parse.
 *
 * The example's own dates are computed here in JS from the SAME `todayISO`
 * passed to the real system prompt, rather than hardcoded — so the worked
 * answer always resolves "tomorrow" and "the 1st of every month" against
 * whatever day this actually runs on, keeping the demonstrated turn
 * internally consistent with the "Today's Date" line the model is told
 * right above it, instead of teaching it two different definitions of today.
 */
function buildFewShotAnswer(todayISO: string): string {
  const [year, month, day] = todayISO.split("-").map(Number);
  const today = new Date(year, month - 1, day);
  const tomorrow = formatIsoDate(addDays(today, 1));
  const nextFirstOfMonth = formatIsoDate(nextDayOfMonth(today, 1));

  return JSON.stringify([
    { task: "Call the dentist", action_date: tomorrow, recurrence: "none" },
    { task: "Pay the rent", action_date: nextFirstOfMonth, recurrence: "monthly" },
  ]);
}

function buildPrompt(rawText: string, todayISO: string): string {
  return (
    "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n" +
    `${buildSystemPrompt(todayISO)}${EOT_TOKEN}` +
    "<|start_header_id|>user<|end_header_id|>\n\n" +
    `${FEW_SHOT_INPUT}${EOT_TOKEN}` +
    "<|start_header_id|>assistant<|end_header_id|>\n\n" +
    `${buildFewShotAnswer(todayISO)}${EOT_TOKEN}` +
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
 * Defensive structural + date normalization on top of whatever the on-device
 * model actually returns. A 1B/3B instruct model is not reliable enough at
 * strict JSON schemas or date arithmetic to trust its output verbatim — any
 * entry missing a task, or carrying a malformed date/recurrence, is either
 * coerced to a safe default (today's date, recurrence "none") or dropped
 * entirely (an empty/missing task), rather than throwing and discarding
 * every other item the model got right.
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

    const actionDate =
      typeof record.action_date === "string" && ISO_DATE_PATTERN.test(record.action_date)
        ? record.action_date
        : todayISO;

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
