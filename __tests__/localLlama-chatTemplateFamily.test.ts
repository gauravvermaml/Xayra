/**
 * 2026-09-16: added Qwen2.5-3B-Instruct as a second candidate model for a
 * quality/prompt-behavior comparison against the Llama 3.2 3B this app has
 * shipped since Build 26. This app hand-assembles its RAG/extraction
 * prompts as raw strings with Llama 3's own special tokens
 * (<|begin_of_text|>, <|start_header_id|>, <|eot_id|>) rather than going
 * through llama.rn's model-agnostic chat-template helper — so swapping in a
 * model from a different family is NOT a drop-in filename change: without a
 * matching prompt builder, Qwen's tokenizer would see Llama's literal
 * token text as ordinary characters instead of the structural turn markers
 * its own instruct fine-tuning expects, silently degrading output quality.
 *
 * Locks in that `buildPrompt()` (services/ai/localLlama.ts) actually
 * branches on which model is loaded — Qwen's ChatML markers
 * (<|im_start|>/<|im_end|>) when a Qwen model resolved, Llama 3's own
 * markers otherwise — by inspecting the real prompt string handed to the
 * (mocked) native completion() call, not just asserting the function
 * exists.
 */

jest.mock("expo-device-cpu", () => ({ getCpuCoreCount: () => 8 }));
jest.mock("../services/ai/localWhisper", () => ({
  isTranscriptionInProgress: jest.fn(() => false),
}));
jest.mock("../services/ai/modelPerformanceTracker", () => ({
  MIN_USABLE_TOKENS_PER_SECOND: 5,
  recordCompletionSpeed: jest.fn(() => Promise.resolve()),
}));
jest.mock("../services/settings/preferences", () => ({
  readPreferences: jest.fn(() => Promise.resolve({ llamaThreadCount: null })),
}));

let capturedPrompt = "";

jest.mock("llama.rn", () => ({
  initLlama: jest.fn(() =>
    Promise.resolve({
      completion: jest.fn((params: { prompt: string }) => {
        capturedPrompt = params.prompt;
        return Promise.resolve({ text: "answer", timings: { predicted_per_second: 10 } });
      }),
      stopCompletion: jest.fn(() => Promise.resolve()),
      release: jest.fn(() => Promise.resolve()),
    })
  ),
}));

function mockFileSystemWithOnlyThisFileExisting(existingFilename: string) {
  jest.doMock("expo-file-system/legacy", () => ({
    documentDirectory: "file:///fake-doc-dir/",
    getInfoAsync: jest.fn((path: string) => Promise.resolve({ exists: path.endsWith(existingFilename) })),
  }));
}

describe("buildPrompt's chat-template-family branching (Qwen2.5-3B comparison, 2026-09-16)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    capturedPrompt = "";
  });

  it("defaults to Llama 3's own template family before any context has loaded", () => {
    const { getActiveChatTemplateFamily } = require("../services/ai/localLlama");
    expect(getActiveChatTemplateFamily()).toBe("llama3");
  });

  it("uses Llama 3's special tokens when the resolved model is a Llama file", async () => {
    mockFileSystemWithOnlyThisFileExisting("Llama-3.2-3B-Instruct-UD-Q4_K_XL.gguf");
    const { generateLocalRAGAnswer, getActiveChatTemplateFamily } = require("../services/ai/localLlama");

    await generateLocalRAGAnswer("what's on my list", "some note context", () => {});

    expect(getActiveChatTemplateFamily()).toBe("llama3");
    expect(capturedPrompt).toContain("<|begin_of_text|>");
    expect(capturedPrompt).toContain("<|eot_id|>");
    expect(capturedPrompt).not.toContain("<|im_start|>");
  });

  it("uses Qwen's ChatML tokens when the resolved model is the Qwen file", async () => {
    mockFileSystemWithOnlyThisFileExisting("Qwen2.5-3B-Instruct-Q4_K_M.gguf");
    const { generateLocalRAGAnswer, getActiveChatTemplateFamily } = require("../services/ai/localLlama");

    await generateLocalRAGAnswer("what's on my list", "some note context", () => {});

    expect(getActiveChatTemplateFamily()).toBe("qwen2");
    expect(capturedPrompt).toContain("<|im_start|>system");
    expect(capturedPrompt).toContain("<|im_start|>assistant");
    expect(capturedPrompt).toContain("<|im_end|>");
    expect(capturedPrompt).not.toContain("<|begin_of_text|>");
  });

  it("the shared stop-token list covers both families' turn markers, so either model's real end-of-turn token actually stops generation", () => {
    const { CHAT_TEMPLATE_STOP_TOKENS } = require("../services/ai/localLlama");
    expect(CHAT_TEMPLATE_STOP_TOKENS).toEqual(expect.arrayContaining(["<|eot_id|>", "<|im_end|>"]));
  });
});
