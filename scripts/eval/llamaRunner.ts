import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the desktop `llama-cli`, used only by the Tier 2 eval
 * harness. The app itself never touches this — on-device inference goes
 * through llama.rn.
 *
 * Running the same GGUF on the desktop is what makes evaluation practical at
 * all: an extraction takes ~80s on the test phone, so a 150-case corpus would
 * be a three-hour run with a human tapping through it. The tradeoff is that
 * this is NOT bit-identical to the device — different thread count, different
 * build flags — so it is a tool for comparing prompts against each other, not
 * for predicting on-device latency or reproducing a device result exactly.
 */

/** winget adds this to PATH, but only for shells started after the install,
 * so the explicit path is tried first and PATH is the fallback. */
const WINGET_LLAMA_CLI = join(
  process.env.LOCALAPPDATA ?? "",
  "Microsoft",
  "WinGet",
  "Packages",
  "ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "llama-cli.exe"
);

export function resolveLlamaCli(): string {
  if (process.env.LLAMA_CLI && existsSync(process.env.LLAMA_CLI)) {
    return process.env.LLAMA_CLI;
  }
  if (existsSync(WINGET_LLAMA_CLI)) {
    return WINGET_LLAMA_CLI;
  }
  // Let execFile resolve it from PATH and surface its own ENOENT if absent.
  return "llama-cli";
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
 * This build wraps generation in an interactive front-end: an ASCII banner, a
 * command list, the echoed prompt (even with `--no-display-prompt`), then the
 * completion, then a throughput line and "Exiting...". Naive prefix-stripping
 * does not survive that, and every case scored as a schema failure until this
 * was replaced.
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
    contextSize = 4096,
    maxTokens = 512,
    timeoutMs = 120_000,
  } = request;

  const workDir = await mkdtemp(join(tmpdir(), "xayra-eval-"));
  const startedAt = Date.now();

  try {
    const promptPath = join(workDir, "prompt.txt");
    await writeFile(promptPath, prompt, "utf8");

    const args = [
      "-m", modelPath,
      "-f", promptPath,
      "-c", String(contextSize),
      "-n", String(maxTokens),
      "--temp", "0",
      "-st",            // single turn: generate once, then exit
      "--no-warmup",    // the warm-up run would double every case's cost
      "--no-display-prompt",
      "-v",  // restores the absolute token count in the timing line
    ];

    if (grammar) {
      const grammarPath = join(workDir, "grammar.gbnf");
      await writeFile(grammarPath, grammar, "utf8");
      args.push("--grammar-file", grammarPath);
    }

    const { stdout, stderr } = await execFileAsync(resolveLlamaCli(), args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });

    return {
      text: extractJsonArray(stdout),
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
