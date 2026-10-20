/**
 * Missing speech model (onboarding finished early): voice capture is refused
 * before the microphone starts, with a plain message — no recording that can
 * only fail to transcribe, so no spoken note is lost.
 */
const mockDownloaded = jest.fn();
jest.mock("../services/ai/whisperModels", () => ({
  isWhisperModelDownloaded: () => mockDownloaded(),
}));

import { checkVoiceReady } from "../services/ai/voiceReadiness";
import { VOICE_MODEL_NOT_READY } from "../constants/copy";

describe("checkVoiceReady", () => {
  it("ready once the speech model is installed", async () => {
    mockDownloaded.mockResolvedValue(true);
    await expect(checkVoiceReady()).resolves.toEqual({ ready: true });
  });

  it("refuses a recording attempt without the model, saying why and that typing works", async () => {
    mockDownloaded.mockResolvedValue(false);
    const voice = await checkVoiceReady();
    expect(voice).toEqual({ ready: false, message: VOICE_MODEL_NOT_READY });
    expect(VOICE_MODEL_NOT_READY).toMatch(/type/i);
    expect(VOICE_MODEL_NOT_READY).not.toMatch(/100%|always offline/i);
  });

  it("an unreadable model path counts as not installed", async () => {
    mockDownloaded.mockRejectedValue(new Error("io"));
    await expect(checkVoiceReady()).resolves.toMatchObject({ ready: false });
  });
});
