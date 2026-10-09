import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildCompletionArgs, CHAT_MODE_FLAGS } from "../scripts/eval/llamaRunner";
import { buildPrompt as buildRagPrompt } from "../services/ai/ragPrompt";

// The Tier 2 harness once ran `llama-cli -st`, which re-applied the model's
// chat template on top of the app's already-templated prompt — every case was
// scored on doubly wrapped input. These pin the argument contract; the
// end-to-end proof (tokenizer count == tokens llama.cpp evaluated) runs at the
// start of every eval via verifyPromptPassedOnce.

const base = { modelPath: "model.gguf", promptPath: "/tmp/prompt.txt", contextSize: 4096, maxTokens: 512 };

describe("eval harness — prompt is passed to the model exactly once, in raw completion mode", () => {
  it("requests raw completion (no conversation mode)", () => {
    expect(buildCompletionArgs(base)).toContain("-no-cnv");
  });

  it("never passes a flag that would apply a chat template on top of the app's prompt", () => {
    const args = buildCompletionArgs({ ...base, stop: ["<|im_end|>"], grammarPath: "/tmp/g.gbnf" });
    for (const flag of CHAT_MODE_FLAGS) {
      expect(args).not.toContain(flag);
    }
  });

  it("supplies the prompt exactly once, byte-for-byte from the prompt file", () => {
    // -bf, not -f: -f strips the trailing newline every app prompt ends with.
    const args = buildCompletionArgs(base);
    expect(args.filter((a) => a === "-bf")).toHaveLength(1);
    expect(args.filter((a) => a === base.promptPath)).toHaveLength(1);
    for (const otherPromptSource of ["-f", "--file", "-p", "--prompt"]) {
      expect(args).not.toContain(otherPromptSource);
    }
  });

  it("keeps greedy decoding, matching the app's temperature 0", () => {
    const args = buildCompletionArgs(base);
    expect(args[args.indexOf("--temp") + 1]).toBe("0");
  });
});

describe("eval prompts use the eval's pinned clock, never the real system date", () => {
  const PINNED = new Date(2026, 9, 2, 15, 0); // the comparison corpus's NOW
  const REAL = new Date(2026, 9, 9, 10, 0); // "today" on the machine running the eval

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(REAL);
  });
  afterEach(() => jest.useRealTimers());

  it("a pinned `now` sets the prompt's 'Today is' line, whatever the system clock says", () => {
    const prompt = buildRagPrompt("Did I celebrate Varun's birthday yesterday?", "--- NOTE 1 ---\nx", PINNED);
    expect(prompt).toContain("Today is Friday, October 2, 2026");
    expect(prompt).not.toContain("October 9");
  });

  it("production calls (no `now`) still use the real date, byte-identically", () => {
    expect(buildRagPrompt("q", "c")).toBe(buildRagPrompt("q", "c", REAL));
    expect(buildRagPrompt("q", "c")).toContain("Today is Friday, October 9, 2026");
  });

  it.each(["runRagComparison.ts", "runTemporalRegression.ts", "runEval.ts"])(
    "%s passes its pinned clock to every RAG prompt it builds",
    (script) => {
      const source = readFileSync(join(__dirname, "..", "scripts", "eval", script), "utf8");
      const ragPromptName = script === "runEval.ts" ? "buildRagPrompt" : "buildPrompt";
      const calls = [...source.matchAll(new RegExp(String.raw`\b${ragPromptName}\(([^()]|\([^()]*\))*\)`, "g"))].map((m) => m[0]);
      expect(calls.length).toBeGreaterThan(0);
      // Two top-level arguments means the real clock would be used.
      for (const call of calls) expect(call.split(",").length).toBeGreaterThanOrEqual(3);
    }
  );
});
