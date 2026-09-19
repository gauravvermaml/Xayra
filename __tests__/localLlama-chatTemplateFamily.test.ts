/**
 * The app ships exactly one chat model (Qwen2.5-1.5B-Instruct, ChatML) with
 * no tier ladder beneath it. Because prompts here are hand-assembled raw
 * strings rather than built through llama.rn's model-agnostic chat-template
 * helper, the prompt builders are written against ChatML specifically —
 * there is no runtime family detection left to get wrong, but there is still
 * a real regression to guard against: a stray Llama-3 marker
 * (<|begin_of_text|>, <|start_header_id|>, <|eot_id|>) left behind in a
 * prompt string would be fed to Qwen's tokenizer as ordinary characters
 * rather than structural turn markers, silently degrading output with no
 * error thrown.
 *
 * These assertions inspect the real prompt handed to the (mocked) native
 * completion() call, not just that the function exists.
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

const LLAMA3_MARKERS = ["<|begin_of_text|>", "<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>"];

describe("RAG prompts are ChatML, for the one model this app ships", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    capturedPrompt = "";
  });

  it("wraps the prompt in Qwen's ChatML turn markers", async () => {
    mockFileSystemWithOnlyThisFileExisting("qwen2.5-1.5b-instruct-q4_k_m.gguf");
    const { generateLocalRAGAnswer } = require("../services/ai/localLlama");

    await generateLocalRAGAnswer("what's on my list", "some note context", () => {});

    expect(capturedPrompt).toContain("<|im_start|>system");
    expect(capturedPrompt).toContain("<|im_start|>user");
    expect(capturedPrompt).toContain("<|im_start|>assistant");
    expect(capturedPrompt).toContain("<|im_end|>");
  });

  it("leaves no Llama-3 template markers anywhere in the prompt", async () => {
    mockFileSystemWithOnlyThisFileExisting("qwen2.5-1.5b-instruct-q4_k_m.gguf");
    const { generateLocalRAGAnswer } = require("../services/ai/localLlama");

    await generateLocalRAGAnswer("what's on my list", "some note context", () => {});

    for (const marker of LLAMA3_MARKERS) {
      expect(capturedPrompt).not.toContain(marker);
    }
  });

  it("refuses to fall back to a retired model file that happens to still be on disk", async () => {
    // The whole point of the single-model cutover: a leftover Llama GGUF from
    // a previous install must never be loaded and prompted with ChatML.
    mockFileSystemWithOnlyThisFileExisting("Llama-3.2-3B-Instruct-UD-Q4_K_XL.gguf");
    const { generateLocalRAGAnswer, LLAMA_MODEL_MISSING_ERROR_PREFIX } = require("../services/ai/localLlama");

    await expect(generateLocalRAGAnswer("what's on my list", "ctx", () => {})).rejects.toThrow(
      LLAMA_MODEL_MISSING_ERROR_PREFIX
    );
  });

  it("stops generation on ChatML's own end-of-turn marker", () => {
    const { CHAT_TEMPLATE_STOP_TOKENS } = require("../services/ai/localLlama");
    expect(CHAT_TEMPLATE_STOP_TOKENS).toEqual(expect.arrayContaining(["<|im_end|>"]));
    expect(CHAT_TEMPLATE_STOP_TOKENS).not.toEqual(expect.arrayContaining(["<|eot_id|>"]));
  });
});
