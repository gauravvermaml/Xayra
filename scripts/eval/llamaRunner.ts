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
  /** Stop strings, for prose (RAG) generation. When set, the output is taken
   * as free text rather than scanned for a JSON array. */
  stop?: readonly string[];
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
 * Pulls a prose answer out of the interactive front-end's stdout: everything
 * after the echoed prompt's final assistant marker, minus the trailing
 * throughput line and "Exiting...".
 */
function extractProse(stdout: string, prompt: string): string {
  // Anchor on the TAIL of the prompt, not on a turn marker.
  //
  // The obvious approach — slice after the last "<|im_start|>assistant" — is
  // wrong here, and silently so. This build echoes the whole prompt back, the
  // echo is line-wrapped, and the marker does not survive verbatim. The slice
  // then failed, the full stdout was returned as the "answer", and every RAG
  // case was scored against the PROMPT. Because the system prompt quotes the
  // refusal line inside LAW 1, the refusal detector matched the instruction
  // text and four correct answers were reported as wrongful refusals.
  //
  // The anchor is the prompt's last line of real CONTENT — the note text or
  // the user's question — taken from the prompt itself so no caller has to
  // supply it. Template markers and the trailing assistant cue are skipped
  // because the echo reformats them; a content line survives intact.
  //
  // A fixed-length tail slice was tried first and did not work: the echo is
  // line-wrapped, so the last N characters never matched, the slice silently
  // returned the whole stdout, and the scorer graded the PROMPT.
  // Works backwards from the end, keeping lines until one turns up that came
  // from the prompt. Everything after the echo is the answer, and nothing in
  // the answer should match a prompt line verbatim.
  //
  // Two anchor-based attempts failed before this. A fixed-length tail slice
  // never matched because the echo is line-wrapped. Anchoring on the prompt's
  // last content line did not work either: this front-end RENDERS the turn
  // markers ("<|im_start|>system" prints as "> system"), so the echo is not a
  // substring of the prompt at all. Both failures were silent — the slice
  // returned the entire stdout, and because the system prompt quotes the
  // refusal line inside LAW 1, the scorer read the instruction as the answer
  // and reported four correct responses as wrongful refusals.
  const promptLines = new Set(
    prompt
      .split(/\r?\n/)
      .map((line) => line.replace(/<\|[a-zA-Z0-9_]+\|>/g, "").trim())
      .filter((line) => line.length > 0)
  );

  const stdoutLines = stdout.split(/\r?\n/).map((line) => line.replace(/<\|[a-zA-Z0-9_]+\|>/g, "").trimEnd());

  const answerLines: string[] = [];
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    const line = stdoutLines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // Blank lines inside an answer are kept, but a run of them before any
      // answer text has been seen is just the front-end's spacing.
      if (answerLines.length > 0) answerLines.unshift(line);
      continue;
    }
    if (trimmed.startsWith("[ Prompt:") || trimmed === "Exiting..." || trimmed.startsWith(">")) {
      continue;
    }
    // The front-end elides long prompts with "... (truncated)", so that line
    // is not a verbatim prompt line and would otherwise be read as answer
    // text. It marks the end of the echo just as reliably.
    if (promptLines.has(trimmed) || trimmed.includes("... (truncated)")) {
      break;
    }
    answerLines.unshift(line);
  }

  let body = answerLines.join("\n");
  // The front-end appends a throughput line and an exit notice after the
  // answer; neither is model output.
  return body
    .split("[ Prompt:")[0]
    .replace(/\bExiting\.\.\.\s*$/, "")
    .trim();
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

    for (const stopString of stop ?? []) {
      args.push("--reverse-prompt", stopString);
    }

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
      // Grammar-constrained cases emit a JSON array; prose cases do not, and
      // scanning them for brackets would mangle the answer.
      text: grammar ? extractJsonArray(stdout) : extractProse(stdout, prompt),
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
