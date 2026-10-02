import { buildCompletionArgs, CHAT_MODE_FLAGS } from "../scripts/eval/llamaRunner";

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
