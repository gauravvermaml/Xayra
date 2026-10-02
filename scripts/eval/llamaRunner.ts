import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the desktop llama.cpp tools, used only by the Tier 2
 * eval harness. The app itself never touches this — on-device inference goes
 * through llama.rn.
 *
 * Running the same GGUF on the desktop is what makes evaluation practical at
 * all: an extraction takes ~80s on the test phone, so a 150-case corpus would
 * be a three-hour run with a human tapping through it. The tradeoff is that
 * this is NOT bit-identical to the device — different thread count, different
 * build flags — so it is a tool for comparing prompts against each other, not
 * for predicting on-device latency or reproducing a device result exactly.
 *
 * RAW COMPLETION, NOT CHAT MODE. Every prompt this app builds is already a
 * complete ChatML string. This harness used to run `llama-cli -st`, which in
 * the installed llama.cpp is conversation-only: it treated the prompt file as
 * a user message and wrapped it in the model's chat template AGAIN, so every
 * case was scored on system/user/assistant turns nested inside a second user
 * turn — input the app never sends (observed 2026-10-02: the run printed the
 * interactive banner and echoed "> <|im_start|>system…"). `llama-completion
 * -no-cnv` feeds the prompt byte-for-byte, exactly once, and
 * `verifyPromptPassedOnce` below checks that on every run.
 */

/** winget adds these to PATH, but only for shells started after the install,
 * so the explicit path is tried first and PATH is the fallback. */
const WINGET_LLAMA_DIR = join(
  process.env.LOCALAPPDATA ?? "",
  "Microsoft",
  "WinGet",
  "Packages",
  "ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe"
);

function resolveTool(envVar: string, exe: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  const winget = join(WINGET_LLAMA_DIR, `${exe}.exe`);
  // Otherwise let execFile resolve it from PATH and surface its own ENOENT.
  return existsSync(winget) ? winget : exe;
}

export const resolveLlamaCompletion = () => resolveTool("LLAMA_COMPLETION", "llama-completion");
export const resolveLlamaTokenize = () => resolveTool("LLAMA_TOKENIZE", "llama-tokenize");

/** Flags that would put llama.cpp into chat/interactive mode, re-applying a
 * chat template on top of a prompt that already has one. Never passed. */
export const CHAT_MODE_FLAGS = ["-st", "--single-turn", "-cnv", "--conversation", "-i", "--interactive", "--jinja", "--chat-template"];

export type CompletionArgsInput = {
  modelPath: string;
  promptPath: string;
  contextSize: number;
  maxTokens: number;
  stop?: readonly string[];
  grammarPath?: string;
  /** Omitted = llama.cpp's default (1.0, off) — what every existing eval ran with. */
  repeatPenalty?: number;
};

/** Pure, so the "prompt passed exactly once, in raw mode" contract is
 * unit-testable without a model (see __tests__/evalHarness-promptOnce.test.ts). */
export function buildCompletionArgs({ modelPath, promptPath, contextSize, maxTokens, stop, grammarPath, repeatPenalty }: CompletionArgsInput): string[] {
  const args = [
    "-m", modelPath,
    // -bf, not -f: llama.cpp strips one trailing newline from a prompt read
    // with -f, and every app prompt ends "<|im_start|>assistant\n" — which
    // llama.rn sends intact. Caught by verifyPromptPassedOnce (72 tokens
    // built, 71 evaluated). -bf reads the file byte-for-byte.
    "-bf", promptPath,
    "-c", String(contextSize),
    "-n", String(maxTokens),
    "--temp", "0",
    "-no-cnv",        // raw completion: no chat template applied on top of ours
    "--no-warmup",    // the warm-up run would double every case's cost
    "--no-display-prompt",
  ];
  for (const stopString of stop ?? []) {
    args.push("-r", stopString);
  }
  if (grammarPath) {
    args.push("--grammar-file", grammarPath);
  }
  if (repeatPenalty !== undefined) {
    args.push("--repeat-penalty", String(repeatPenalty));
  }
  return args;
}

export type CompletionRequest = {
  modelPath: string;
  prompt: string;
  /** GBNF source. Written to a temp file because `--grammar-file` takes a
   * path, and the grammar is far too long and quote-heavy for a CLI arg. */
  grammar?: string;
  contextSize?: number;
  maxTokens?: number;
  /** Fails the case rather than hanging the whole run on a model that has
   * started looping and will not emit a stop token. */
  timeoutMs?: number;
  /** Stop strings, for prose (RAG) generation. When set, the output is taken
   * as free text rather than scanned for a JSON array. */
  stop?: readonly string[];
  repeatPenalty?: number;
};

export type CompletionResult = {
  text: string;
  /** Parsed from llama-cli's own timing output on stderr — the generated
   * token count, used for the token-efficiency metric. */
  outputTokens: number | null;
  durationMs: number;
};

/**
 * Token counts, where this build reports them.
 *
 * b11026's interactive front-end prints only throughput ("Generation: 17.2
 * t/s") with no absolute count, and does so on stdout rather than stderr.
 * `-v` restores the classic "eval time = N ms / M runs" line, so both shapes
 * are accepted and the metric degrades to `null` rather than guessing.
 */
const EVAL_TOKENS_PATTERNS = [
  // Negative lookbehind is load-bearing: llama.cpp prints BOTH "prompt eval
  // time = ... / N tokens" and "eval time = ... / M runs". Without it the
  // first match wins and every case reports the ~2,200-token PROMPT as its
  // output length, which is exactly backwards for a token-efficiency metric.
  /(?<!prompt )eval time\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s*(?:runs|tokens)/i,
  /Generation:\s*[\d.]+\s*t\/s\s*\|\s*(\d+)\s*tokens/i,
];

function parseOutputTokens(...streams: string[]): number | null {
  for (const stream of streams) {
    for (const pattern of EVAL_TOKENS_PATTERNS) {
      const match = stream.match(pattern);
      if (match) {
        return Number(match[1]);
      }
    }
  }
  return null;
}

/**
 * Pulls the model's actual answer out of llama-cli's stdout.
 *
 * Raw completion prints only the generated text, but anchoring on the last
 * balanced array (rather than trusting stdout to be exactly the JSON) stays
 * robust to llama.cpp's own trailing markers.
 *
 * Grammar-constrained extraction always emits a single JSON array, so the
 * reliable anchor is the LAST balanced `[...]` in the stream. Scanning
 * backwards also means a bracket inside the echoed prompt cannot win over the
 * real output.
 */
function extractJsonArray(stdout: string): string {
  for (let end = stdout.lastIndexOf("]"); end !== -1; end = stdout.lastIndexOf("]", end - 1)) {
    let depth = 0;
    for (let start = end; start >= 0; start--) {
      const char = stdout[start];
      if (char === "]") depth++;
      else if (char === "[") depth--;

      if (depth === 0) {
        const candidate = stdout.slice(start, end + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break; // balanced but not valid JSON — try an earlier "]"
        }
      }
    }
  }
  // Nothing parseable: hand back the raw text so the scorer records a genuine
  // schema failure rather than the harness masking it.
  return stdout.trim();
}

/**
 * A prose answer from raw-completion stdout. With `--no-display-prompt` and
 * no chat front-end, stdout is the generated text plus llama.cpp's own
 * "[end of text]" marker — the echoed-prompt and banner parsing the old
 * `llama-cli -st` path needed (and repeatedly got wrong) no longer applies.
 */
function extractProse(stdout: string, stop: readonly string[]): string {
  let text = stdout.replace(/\s*\[end of text\]\s*$/, "");
  for (const stopString of stop) {
    if (text.endsWith(stopString)) {
      text = text.slice(0, -stopString.length);
    }
  }
  return text.trim();
}

const PROMPT_EVAL_TOKENS = /prompt eval time\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s*tokens/i;
const TOKENIZED_COUNT = /Total number of tokens:\s*(\d+)/i;

/**
 * Proves the model receives `prompt` exactly once, as written: counts its
 * tokens independently with `llama-tokenize`, then runs a one-token raw
 * completion over the same file and compares with the prompt-token count
 * llama.cpp itself reports processing. A chat template applied on top (the
 * old `llama-cli -st` bug) adds template tokens and fails this; so would a
 * prompt duplicated or truncated on the way in. Throws on mismatch so a run
 * can never silently score the wrong input again.
 */
export async function verifyPromptPassedOnce(modelPath: string, prompt: string): Promise<{ tokenized: number; evaluated: number }> {
  const workDir = await mkdtemp(join(tmpdir(), "xayra-eval-check-"));
  try {
    const promptPath = join(workDir, "prompt.txt");
    await writeFile(promptPath, prompt, "utf8");
    const tokenize = await execFileAsync(resolveLlamaTokenize(), ["-m", modelPath, "-f", promptPath, "--ids", "--show-count", "--log-disable"], {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    const tokenized = Number((tokenize.stdout + tokenize.stderr).match(TOKENIZED_COUNT)?.[1] ?? NaN);
    const completion = await execFileAsync(
      resolveLlamaCompletion(),
      buildCompletionArgs({ modelPath, promptPath, contextSize: 4096, maxTokens: 1 }),
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 300_000 }
    );
    const evaluated = Number(completion.stderr.match(PROMPT_EVAL_TOKENS)?.[1] ?? NaN);
    if (!Number.isFinite(tokenized) || !Number.isFinite(evaluated) || tokenized !== evaluated) {
      throw new Error(
        `Prompt was not passed to the model exactly once: tokenizer counts ${tokenized} tokens, ` +
          `llama.cpp evaluated ${evaluated}. A chat template or duplicated input is being added.`
      );
    }
    return { tokenized, evaluated };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Runs one completion. Temp files are created under a unique directory per
 * call and removed in `finally`, so a thrown error, a timeout, or a failed
 * assertion never leaves a multi-KB prompt or grammar behind — a 150-case run
 * would otherwise litter the temp directory every time it failed partway.
 */
export async function runCompletion(request: CompletionRequest): Promise<CompletionResult> {
  const {
    modelPath,
    prompt,
    grammar,
    stop,
    contextSize = 4096,
    maxTokens = 512,
    timeoutMs = 120_000,
  } = request;

  const workDir = await mkdtemp(join(tmpdir(), "xayra-eval-"));
  const startedAt = Date.now();

  try {
    const promptPath = join(workDir, "prompt.txt");
    await writeFile(promptPath, prompt, "utf8");

    let grammarPath: string | undefined;
    if (grammar) {
      grammarPath = join(workDir, "grammar.gbnf");
      await writeFile(grammarPath, grammar, "utf8");
    }
    const args = buildCompletionArgs({ modelPath, promptPath, contextSize, maxTokens, stop, grammarPath, repeatPenalty: request.repeatPenalty });

    const { stdout, stderr } = await execFileAsync(resolveLlamaCompletion(), args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });

    return {
      // Grammar-constrained cases emit a JSON array; prose cases do not, and
      // scanning them for brackets would mangle the answer.
      text: grammar ? extractJsonArray(stdout) : extractProse(stdout, stop ?? []),
      outputTokens: parseOutputTokens(stdout, stderr),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {
      // Cleanup is best effort — a leftover temp dir must never mask the real
      // result or error from the case being scored.
    });
  }
}
