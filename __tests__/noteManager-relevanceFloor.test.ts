/**
 * QA Phase 3, Agent 4 test backlog item 8 (qa/04-test-strategy-report.md):
 * locks in the Build 38 retrieval relevance floor (`MAX_NOTE_VECTOR_DISTANCE
 * = 0.4`, services/notes/noteManager.ts) against the exact real on-device
 * calibration data cited in its own doc comment — a genuinely relevant note
 * measured at distance 0.281, three unrelated notes all clustered between
 * 0.501 and 0.531. The floor must exclude the two documented false
 * positives and include a true positive below it.
 */
jest.mock("../db/client", () => ({
  getRawDatabase: jest.fn(),
  isFtsAvailable: jest.fn(() => Promise.resolve(false)),
}));
jest.mock("../services/ai/embeddingModel", () => ({
  isEmbeddingModelDownloaded: jest.fn(() => Promise.resolve(true)),
}));
jest.mock("../services/ai/localEmbeddings", () => ({
  generateEmbeddingLocal: jest.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
}));
jest.mock("../services/ai/perf", () => ({
  logDuration: jest.fn(),
  nowMs: jest.fn(() => 0),
}));
jest.mock("../services/ai/pipelineStage", () => ({
  setPipelineStage: jest.fn(),
}));
jest.mock("../services/ai/transformationEngine", () => ({
  extractToDosFromText: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../services/todos/todoManager", () => ({
  addToDo: jest.fn(),
}));
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true })),
}));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "fake-id") }));

import { isWithinRelevanceFloor } from "../services/notes/noteManager";

describe("isWithinRelevanceFloor (Phase 3, Agent 4 backlog item 8)", () => {
  it("includes the documented true-positive distance (0.281)", () => {
    expect(isWithinRelevanceFloor(0.281)).toBe(true);
  });

  it("excludes both documented false-positive distances (0.501, 0.531)", () => {
    expect(isWithinRelevanceFloor(0.501)).toBe(false);
    expect(isWithinRelevanceFloor(0.531)).toBe(false);
  });

  it("excludes exactly the floor itself (strict less-than, 0.4 is not included)", () => {
    expect(isWithinRelevanceFloor(0.4)).toBe(false);
  });

  it("includes a distance just below the floor", () => {
    expect(isWithinRelevanceFloor(0.399)).toBe(true);
  });

  it("includes a perfect/near-identical match (distance 0)", () => {
    expect(isWithinRelevanceFloor(0)).toBe(true);
  });
});
