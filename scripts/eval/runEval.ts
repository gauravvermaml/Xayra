import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPrompt,
  containsExtractionTrigger,
  detectDatePhrases,
  setExtractionPromptMode,
  normalizeExtracted,
  parseExtractionOutput,
  preFilterZeroTaskNotes,
  TODO_EXTRACTION_GRAMMAR,
  type ExtractedToDo,
} from "../../services/ai/extractionLogic";
import {
  buildPrompt as buildRagPrompt,
  CHAT_TEMPLATE_STOP_TOKENS,
  setRagPromptMode,
} from "../../services/ai/ragPrompt";
import { buildNoteContext, sanitizeLLMResponse } from "../../services/ai/ragFormatting";
import { runCompletion, verifyPromptPassedOnce } from "./llamaRunner";
import { renderReport } from "./report";
import { aggregate, scoreCase, scoreRagCase, type EvalCase, type CaseScore } from "./scoring";

/**
 * Tier 2 evaluation harness.
 *
 * Runs the app's REAL prompt builders and REAL reconciliation against the real
 * quantized model, on the desktop, so a corpus can be scored in minutes rather
 * than the ~80s per case an on-device run costs.
 *
 * The pipeline below deliberately mirrors `extractToDosFromText()` step for
 * step, minus the orchestration (thermal gating, queueing, persistence). Any
 * divergence would mean measuring the harness rather than the app.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const DEFAULT_MODEL = join(repoRoot, "models", "qwen2.5-1.5b-instruct-q4_k_m.gguf");

/** Qwen3's own chat template switches reasoning off (enable_thinking=False)
 * by pre-filling an empty think block after the assistant marker. Only for
 * evaluating a stock Qwen3 checkpoint via `--no-think`; the app's own model
 * is Qwen2.5 and never sees this. */
const QWEN3_NO_THINK_SUFFIX = "<think>\n\n</think>\n\n";
let noThink = false;
const finalizePrompt = (prompt: string) => (noThink ? prompt + QWEN3_NO_THINK_SUFFIX : prompt);

async function loadCorpus(path: string): Promise<EvalCase[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map((line, i) => {
      try {
        return JSON.parse(line) as EvalCase;
      } catch (err) {
        throw new Error(`corpus line ${i + 1} is not valid JSON: ${(err as Error).message}`);
      }
    });
}

/**
 * Mirrors the app's own extraction path. `parseExtractionOutput` throwing is a
 * real result (schema non-compliance), not a harness error, so it is caught
 * and reported as `null` rather than aborting the run.
 */
/** A fixed, reproducible stand-in for "now" — 9 AM on the case's own
 * `today` — so the before/after-1pm default-reminder-time branch (see
 * computeDefaultReminderDateTime in extractionLogic.ts) scores identically
 * regardless of what wall-clock time this harness happens to run at. 9 AM
 * is deliberately before the 1pm cutoff, matching what every existing
 * corpus expectation around a defaulted date/time was already written
 * against.
 */
function evalCaseNow(evalCase: EvalCase): Date {
  const [year, month, day] = evalCase.today.split("-").map(Number);
  return new Date(year, month - 1, day, 9, 0);
}

/**
 * Evaluation-only: skip the Build 50 explicit-intent gate. Most of
 * corpus-full.jsonl predates that gate — 82 of its 91 extraction notes carry
 * no "remind me"/"make a note" phrase, so with the gate on, 56 cases that
 * expect tasks fail before any model runs and the score measures the gate,
 * not the model. `--no-trigger-gate` reproduces the pipeline the 94.2%
 * baseline was measured on, so models can be compared on extraction itself.
 * Production extraction is unaffected.
 */
let triggerGate = true;

function parseAndReconcile(rawOutput: string, evalCase: EvalCase, detectedPhrases: string[]): ExtractedToDo[] | null {
  try {
    const parsed = parseExtractionOutput(rawOutput);
    // Mirrors extractToDosFromText: auto-fill widening only applies when the
    // note really carries a trigger phrase (always true when the gate is on,
    // since runCase only reaches here past it; the pre-gate default, false,
    // for gate-less notes when --no-trigger-gate is used).
    return normalizeExtracted(parsed, evalCase.today, evalCase.note, detectedPhrases, containsExtractionTrigger(evalCase.note), evalCaseNow(evalCase));
  } catch {
    return null;
  }
}

/**
 * Mirrors generateRAGAnswer(), minus retrieval: the corpus supplies the notes
 * directly so grounding is measured against a FIXED context. Letting real
 * hybrid search pick the notes would conflate two different failures — bad
 * retrieval and bad grounding — and make the score non-reproducible.
 *
 * The empty-context string is copied from rag.ts deliberately; the prompt's
 * refusal behaviour is tuned to that exact framing.
 */
async function runRagCase(evalCase: EvalCase, modelPath: string): Promise<CaseScore> {
  const contexts = evalCase.contexts ?? [];
  const noteContext =
    contexts.length > 0
      ? buildNoteContext(
          contexts.map((c) => ({ content: c.content, transcript: null, createdAt: c.createdAt })),
          null
        ).contextText
      : "--- NOTE CONTEXT ---\nNo relevant voice notes were found.";

  const prompt = finalizePrompt(buildRagPrompt(evalCase.query ?? "", noteContext, evalCaseNow(evalCase)));
  const completion = await runCompletion({
    modelPath,
    prompt,
    contextSize: 4096,
    maxTokens: 512,
    stop: CHAT_TEMPLATE_STOP_TOKENS,
  });

  const answer = sanitizeLLMResponse(completion.text);
  return scoreRagCase(evalCase, answer, completion.outputTokens, completion.durationMs);
}

async function runCase(evalCase: EvalCase, modelPath: string): Promise<CaseScore> {
  if (evalCase.kind === "rag") {
    return runRagCase(evalCase, modelPath);
  }

  // Mirrors extractToDosFromText()'s own explicit-intent gate — a corpus
  // case with no "remind me"/"make a note" trigger phrase now correctly
  // extracts nothing in the real app, so the harness must score that as the
  // expected `[]` too, not run it through the model anyway.
  if (triggerGate && !containsExtractionTrigger(evalCase.note)) {
    return scoreCase(evalCase, [], "[]", 0, 0);
  }

  // Mirrors extractToDosFromText()'s own pre-filter short-circuit (Hybrid
  // Architecture) — any divergence here would mean the harness is scoring a
  // pipeline the app doesn't actually run, exactly the failure mode this
  // harness exists to avoid (see runCase's own module doc comment).
  if (preFilterZeroTaskNotes(evalCase.note)) {
    return scoreCase(evalCase, [], "[]", 0, 0);
  }

  const detectedPhrases = detectDatePhrases(evalCase.note, evalCase.today);
  const prompt = finalizePrompt(buildPrompt(evalCase.note, evalCase.today, detectedPhrases));

  const completion = await runCompletion({
    modelPath,
    prompt,
    grammar: TODO_EXTRACTION_GRAMMAR,
    contextSize: 4096,
    maxTokens: 512,
  });

  const actual = parseAndReconcile(completion.text, evalCase, detectedPhrases);
  return scoreCase(evalCase, actual, completion.text, completion.outputTokens, completion.durationMs);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Scoring a fine-tuned model means scoring it with the prompt it was
  // trained against, not the one the stock model needs. Opt-in, because the
  // minimal prompt strips every rule and example the stock model depends on.
  const promptArg = args.indexOf("--prompt");
  const promptMode = promptArg !== -1 ? args[promptArg + 1] : process.env.XAYRA_EXTRACTION_PROMPT;
  if (promptMode === "minimal" || promptMode === "full") {
    setExtractionPromptMode(promptMode);
    setRagPromptMode(promptMode);
  } else if (promptMode) {
    console.error(`  Unknown prompt mode "${promptMode}" — use "full" or "minimal".`);
    process.exit(2);
  }
  const modelArg = args.indexOf("--model");
  const modelPath = modelArg !== -1 ? args[modelArg + 1] : process.env.EVAL_MODEL ?? DEFAULT_MODEL;

  const corpusArg = args.indexOf("--corpus");
  const corpusPath = corpusArg !== -1 ? args[corpusArg + 1] : join(here, "corpus.jsonl");

  const filterArg = args.indexOf("--filter");
  const filter = filterArg !== -1 ? args[filterArg + 1] : null;

  noThink = args.includes("--no-think");
  triggerGate = !args.includes("--no-trigger-gate");
  const jsonArg = args.indexOf("--json");
  const jsonPath = jsonArg !== -1 ? args[jsonArg + 1] : null;

  if (!existsSync(modelPath)) {
    console.error(`\n  Model not found: ${modelPath}`);
    console.error("  Download it with:");
    console.error(
      "    curl -L -o models/qwen2.5-1.5b-instruct-q4_k_m.gguf \\\n" +
        "      https://xayra-models-proxy.vermagauravsingh.workers.dev/qwen2.5-1.5b-instruct-q4_k_m.gguf\n"
    );
    process.exit(2);
  }

  let corpus = await loadCorpus(corpusPath);
  if (filter) {
    corpus = corpus.filter((c) => c.id.includes(filter) || c.category.includes(filter));
  }
  if (corpus.length === 0) {
    console.error("  No cases matched.");
    process.exit(2);
  }

  // Refuse to score anything unless the model provably receives each prompt
  // exactly once, as built — see verifyPromptPassedOnce. Probed with a real
  // extraction prompt (and the Qwen3 suffix when --no-think is on), so the
  // check covers the exact transform every case goes through.
  const probeNote = "Remind me to call the dentist tomorrow at 10am.";
  const probeToday = "2026-10-02";
  const probe = finalizePrompt(buildPrompt(probeNote, probeToday, detectDatePhrases(probeNote, probeToday)));
  const check = await verifyPromptPassedOnce(modelPath, probe);
  console.log(`\n  Prompt passed exactly once: ${check.tokenized} tokens built = ${check.evaluated} tokens evaluated`);

  process.stdout.write(`\n  Running ${corpus.length} case${corpus.length === 1 ? "" : "s"}`);

  const scores: CaseScore[] = [];
  for (const evalCase of corpus) {
    // Sequential on purpose: parallel cases would contend for CPU and make the
    // per-case timings meaningless, and those timings are one of the metrics.
    scores.push(await runCase(evalCase, modelPath));
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const summary = aggregate(scores);
  const label = `${modelPath.split(/[\\/]/).pop() ?? modelPath}  [prompt: ${promptMode ?? "full"}${noThink ? ", no-think" : ""}${triggerGate ? "" : ", no trigger gate"}]`;
  console.log(renderReport(scores, summary, label));
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify({ label, summary, scores }, null, 2), "utf8");
  }

  // Non-zero exit on any failure so this can gate a commit or CI step.
  process.exit(summary.passed === summary.total ? 0 : 1);
}

main().catch((err) => {
  console.error("\n  Eval run failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
