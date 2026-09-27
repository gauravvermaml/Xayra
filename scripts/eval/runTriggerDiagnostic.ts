import {
  buildPrompt,
  containsExtractionTrigger,
  detectDatePhrases,
  normalizeExtracted,
  parseExtractionOutput,
  preFilterZeroTaskNotes,
  TODO_EXTRACTION_GRAMMAR,
} from "../../services/ai/extractionLogic";
import { runCompletion } from "./llamaRunner";

/**
 * One-off diagnostic for the trigger-phrase gating design — NOT part of the
 * regular `npm run eval` corpus. It exists to answer one specific question
 * asked mid-conversation: given real multi-sentence notes where the date/
 * subject lives in a DIFFERENT sentence from the "remind me" clause, what
 * does the real fine-tuned model actually produce, end to end (trigger gate
 * -> prompt -> completion -> reconciliation)? The three notes below are
 * exactly the ones discussed, verbatim (typos included — that is the real
 * input a voice transcript would produce).
 *
 * Mirrors runEval.ts's runCase() step for step, but prints the actual
 * resolved ExtractedToDo[] for every case rather than scoring it against a
 * pre-guessed expectation — several of these outcomes were genuinely
 * uncertain going in (would "book accommodation and ski hire" split into two
 * tasks or stay one? does the model correctly resolve "it" back to "car
 * rego"?), so a fixed pass/fail corpus entry would have meant guessing the
 * answer before the point of asking the question.
 *
 * Run with: npx tsx scripts/eval/runTriggerDiagnostic.ts
 */

const MODEL_PATH = "models/qwen-task-extractor-q4_k_m.gguf"; // the production fine-tuned model

const CASES: { id: string; today: string; note: string }[] = [
  {
    id: "queenstown-trip",
    today: "2026-09-27",
    note: "Queenstown trip is 14th to 21st November. Remind me to book accomodation and skii hire",
  },
  {
    id: "mums-flight",
    today: "2026-09-27",
    note: "Mum's flight lands Tuesday the 22nd at 6:40 am, terminal 1. Remind me to arrange the airport pickup.",
  },
  {
    id: "car-rego",
    today: "2026-09-27",
    note: "Car rego expures 30th Sep.. Remind me to renew it before it lapses.",
  },
];

async function runOne(id: string, today: string, note: string): Promise<void> {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  ${id}`);
  console.log(`  note: "${note}"`);
  console.log(`  today: ${today}`);
  console.log("=".repeat(72));

  if (!containsExtractionTrigger(note)) {
    console.log("  [gate] no trigger phrase found — extraction would NOT run. []");
    return;
  }
  console.log("  [gate] trigger phrase found — proceeding.");

  if (preFilterZeroTaskNotes(note)) {
    console.log("  [pre-filter] matched a zero-task shape — extraction would NOT run. []");
    return;
  }

  const detectedPhrases = detectDatePhrases(note, today);
  console.log(`  [chrono] detected date phrases: ${JSON.stringify(detectedPhrases)}`);

  const prompt = buildPrompt(note, today, detectedPhrases);
  const completion = await runCompletion({
    modelPath: MODEL_PATH,
    prompt,
    grammar: TODO_EXTRACTION_GRAMMAR,
    contextSize: 4096,
    maxTokens: 512,
  });

  console.log(`  [model] raw output: ${completion.text}`);
  console.log(`  [model] duration: ${(completion.durationMs / 1000).toFixed(1)}s`);

  try {
    const parsed = parseExtractionOutput(completion.text);
    // 9am: deliberately before the 1pm default-reminder-time cutoff (see
    // computeDefaultReminderDateTime in extractionLogic.ts) so these results
    // stay comparable to the first diagnostic run regardless of what time
    // this script happens to be re-run at.
    const [y, m, d] = today.split("-").map(Number);
    const now = new Date(y, m - 1, d, 9, 0);
    const resolved = normalizeExtracted(parsed, today, note, detectedPhrases, true, now);
    console.log("  [final] resolved to-do(s):");
    for (const item of resolved) {
      console.log(
        `    - "${item.task}" | actionDate=${item.actionDate} | toDate=${item.toDate ?? "null"} | ` +
          `notificationTime=${item.notificationTime} | recurrence=${item.recurrence}` +
          (item.recurrenceInterval > 1 ? ` x${item.recurrenceInterval}` : "")
      );
    }
    if (resolved.length === 0) {
      console.log("    (none)");
    }
  } catch (err) {
    console.log(`  [final] FAILED TO PARSE: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  for (const c of CASES) {
    await runOne(c.id, c.today, c.note);
  }
  console.log(`\n${"=".repeat(72)}\n`);
}

main().catch((err) => {
  console.error("Diagnostic run failed:", err);
  process.exit(1);
});
