/**
 * Temporal-resolution regression: the six required questions against the
 * exact seeded hot-day note, run through the app's real pipeline end to end —
 * question target → event-date eligibility → context construction → the
 * exact prompt `buildPrompt` sends → generation → sanitize → date check →
 * grounding check → the same fallback messages rag.ts shows. Prints the
 * actual generated answers and llama.cpp's own timings; it does not assert
 * on them (they are behavioral regression checks, not few-shot examples —
 * nothing here is fed into the prompt).
 *
 * Uses `llama-completion -no-cnv` (raw completion) rather than
 * scripts/eval/llamaRunner.ts: that runner calls `llama-cli -st`, which in
 * the installed llama.cpp runs chat mode and wraps the already-templated
 * prompt in a second chat turn (see BACKLOG.md). Raw completion feeds the
 * prompt byte-for-byte as the app does.
 *
 * Differences from the phone that remain: x86 vs ARM floating point and
 * speed, and the repeat penalty — llama.rn penalizes only generated tokens,
 * llama.cpp's CLI also counts prompt tokens — so both 1.0 and the app's 1.15
 * are run. Desktop timings compare models with each other, not with the
 * phone.
 *
 *   npx tsx scripts/eval/runTemporalRegression.ts [--model path.gguf] [--prompt-mode minimal|full] [--no-think]
 *
 * --no-think appends Qwen3's empty think block after the assistant marker —
 * how Qwen3's own chat template switches reasoning off (enable_thinking=False).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildNoteContext, finalizeAnswer, truncateForContext } from "../../services/ai/ragFormatting";
import { buildPrompt, setRagPromptMode, type RagPromptMode } from "../../services/ai/ragPrompt";
import {
  buildGroundedQuestion,
  classifyEventEvidence,
  detectEventVerification,
  questionTerms,
  rankNotesForTarget,
  resolveQueryTemporalTarget,
} from "../../services/ai/temporalResolver";

const run = promisify(execFile);

const LLAMA_COMPLETION = join(
  process.env.LOCALAPPDATA ?? "",
  "Microsoft",
  "WinGet",
  "Packages",
  "ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "llama-completion.exe"
);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const MODEL = arg("--model") ?? join("models", "qwen-task-extractor-q4_k_m.gguf");
const PROMPT_MODE = (arg("--prompt-mode") ?? "minimal") as RagPromptMode;
const NO_THINK = process.argv.includes("--no-think");
const NOW = new Date(2026, 9, 2, 15, 0);
const EMPTY_CONTEXT = "--- NOTE CONTEXT ---\nNo relevant voice notes were found.";

const HOT_DAY_NOTE = {
  content:
    "It was a very hot day today, perhaps 40 degrees plus. Quite unusual for this month. Last year same time it was so much better. " +
    "Glad we had a plunge pool to cool ourselves off, which we didn't have last year. We caught up with a bunch of friends, had a few beers " +
    "and called it a day. I am reading an interesting history book these days, it's called Why West Rules for Now.",
  transcript: null,
  createdAt: Math.floor(new Date(2025, 9, 15, 12).getTime() / 1000),
};

const QUESTIONS = [
  "How was the weather last year?",
  "How was the weather in 2024?",
  "How was the weather in 2025 compared with 2024?",
  "Was 2025 hotter than the previous year?",
  "How was the weather two years ago?",
  "What happened in 2025?",
];

type Generation = { raw: string; promptMs: number; promptTokens: number; evalMs: number; evalTokens: number };

async function generate(prompt: string, repeatPenalty: string, dir: string): Promise<Generation> {
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, prompt, "utf8");
  const { stdout, stderr } = await run(
    LLAMA_COMPLETION,
    // -bf, not -f: -f strips the trailing newline every app prompt ends with.
    ["-m", MODEL, "-bf", promptPath, "-c", "4096", "-n", "256", "--temp", "0", "--repeat-penalty", repeatPenalty,
     "-no-cnv", "--no-warmup", "--no-display-prompt", "-r", "<|im_end|>", "-r", "<|endoftext|>"],
    { timeout: 300_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }
  );
  const promptTiming = stderr.match(/prompt eval time =\s*([\d.]+) ms \/\s*(\d+)/);
  const evalTiming = stderr.match(/^(?!.*prompt eval).*\beval time =\s*([\d.]+) ms \/\s*(\d+)/m);
  return {
    raw: stdout.replace(/\s*\[end of text\]\s*$/, "").replace(/^<think>\s*<\/think>\s*/, "").trim(),
    promptMs: Number(promptTiming?.[1] ?? NaN),
    promptTokens: Number(promptTiming?.[2] ?? NaN),
    evalMs: Number(evalTiming?.[1] ?? NaN),
    evalTokens: Number(evalTiming?.[2] ?? NaN),
  };
}


async function main() {
  if (!existsSync(LLAMA_COMPLETION) || !existsSync(MODEL)) {
    console.error(`Missing ${existsSync(LLAMA_COMPLETION) ? MODEL : LLAMA_COMPLETION}`);
    process.exit(1);
  }
  setRagPromptMode(PROMPT_MODE);
  console.log(`model: ${MODEL}   prompt mode: ${PROMPT_MODE}   thinking: ${NO_THINK ? "off (empty think block)" : "model default"}`);
  const dir = await mkdtemp(join(tmpdir(), "xayra-temporal-"));
  try {
    for (const question of QUESTIONS) {
      // rag.ts's path: rank → context → verification/grounded question → finalizeAnswer.
      const target = resolveQueryTemporalTarget(question, NOW);
      const verification = detectEventVerification(question, NOW, target);
      const eventTerms = verification?.eventTerms ?? [];
      const ranked = target
        ? rankNotesForTarget(
            [{ note: HOT_DAY_NOTE, text: truncateForContext(HOT_DAY_NOTE.content), createdAt: HOT_DAY_NOTE.createdAt }],
            target,
            { question: questionTerms(question, NOW), event: eventTerms },
            3
          )
        : [];
      const built = ranked.length > 0 ? buildNoteContext(ranked.map((r) => r.note), target, { eventTerms }) : null;
      const hadNotes = !!built && built.includedIndices.length > 0;
      const contextText = hadNotes && built ? built.contextText : EMPTY_CONTEXT;
      const memories = hadNotes && built ? built.memories : [];
      const evidence = hadNotes && built ? built.evidence : [];
      const eventEvidence = verification && target ? classifyEventEvidence(memories, target, eventTerms) : null;
      const groundedQuestion = verification ? buildGroundedQuestion(question, NOW) : question;

      console.log(`\n======== ${question}`);
      console.log(`target: ${JSON.stringify(target)}   selected: ${JSON.stringify(ranked.map((r) => r.reason))}${verification ? `   grounded question: ${groundedQuestion}` : ""}`);
      console.log(contextText.split("\n").map((l) => `  | ${l}`).join("\n"));
      const prompt = buildPrompt(groundedQuestion, contextText) + (NO_THINK ? "<think>\n\n</think>\n\n" : "");
      for (const penalty of ["1.0", "1.15"]) {
        const g = await generate(prompt, penalty, dir);
        const { text: final, outcome } = finalizeAnswer({
          raw: g.raw,
          notesIncluded: hadNotes ? 1 : 0,
          contextText,
          question: groundedQuestion,
          memories,
          evidence,
          target,
          now: NOW,
          eventEvidence,
        });
        console.log(`  repeat-penalty ${penalty}   [prompt ${g.promptTokens} tok ${g.promptMs.toFixed(0)}ms | generated ${g.evalTokens} tok ${g.evalMs.toFixed(0)}ms]`);
        console.log(`    raw:   ${JSON.stringify(g.raw)}`);
        console.log(`    final: ${JSON.stringify(final)}   [${outcome}]`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main();
