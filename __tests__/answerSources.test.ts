/**
 * Redmi uplift Stage 3: every answer that rests on the user's notes shows
 * them — a verified answer as its citations, an unverified one as Related
 * notes (never as proof), including summaries of the latest notes; the
 * fallback never promises related notes over an empty list. Synthetic notes.
 */
const mockSearch = jest.fn();
jest.mock("../services/notes/noteManager", () => ({
  hybridSearchNotes: (...a: unknown[]) => mockSearch(...a),
  getRecentNotes: (...a: unknown[]) => mockSearch(...a),
  getNotesForTarget: (...a: unknown[]) => mockSearch(...a),
}));
const mockGenerate = jest.fn();
jest.mock("../services/ai/localLlama", () => {
  class LlamaCancelledError extends Error {}
  return { LlamaCancelledError, generateLocalRAGAnswer: (...a: unknown[]) => mockGenerate(...a) };
});

import { generateRAGAnswer, relatedNoteIndices, unverifiedWording } from "../services/ai/rag";
import { UNVERIFIED_ANSWER_MESSAGE, UNVERIFIED_NO_RELATED_MESSAGE } from "../services/ai/ragFormatting";

const NOTE = (id: string, content: string) => ({
  id,
  content,
  transcript: null,
  audioUri: null,
  transcriptionModel: null,
  createdAt: Math.floor(new Date(2026, 9, 5, 18, 0).getTime() / 1000),
  score: 1,
});

beforeEach(() => {
  mockSearch.mockReset();
  mockGenerate.mockReset();
});

describe("relatedNoteIndices", () => {
  const base = { verified: false, notesShown: true, included: [0, 2], aboutQuestion: () => [2] };

  it("a verified answer offers citations, not related notes", () => {
    expect(relatedNoteIndices({ ...base, verified: true, retrievalPath: "hybrid" })).toEqual([]);
  });
  it("no notes shown, none related", () => {
    expect(relatedNoteIndices({ ...base, notesShown: false, retrievalPath: "recent" })).toEqual([]);
  });
  it("a specific question: only the shown notes about it", () => {
    expect(relatedNoteIndices({ ...base, retrievalPath: "hybrid" })).toEqual([2]);
  });
  it("a recent-notes request (a summary) is about every note it was shown", () => {
    expect(relatedNoteIndices({ ...base, retrievalPath: "recent" })).toEqual([0, 2]);
  });
});

describe("unverifiedWording", () => {
  it("promises related notes only when there are some to show", () => {
    expect(unverifiedWording(UNVERIFIED_ANSWER_MESSAGE, 2)).toBe(UNVERIFIED_ANSWER_MESSAGE);
    expect(unverifiedWording(UNVERIFIED_ANSWER_MESSAGE, 0)).toBe(UNVERIFIED_NO_RELATED_MESSAGE);
  });
  it("never touches a generated answer", () => {
    expect(unverifiedWording("Theo fixed the fence.", 0)).toBe("Theo fixed the fence.");
  });
});

describe("generateRAGAnswer — sources on screen", () => {
  it("a grounded answer cites the notes it rests on", async () => {
    mockSearch.mockResolvedValue([NOTE("n1", "Theo fixed the fence at the cottage.")]);
    mockGenerate.mockResolvedValue("Theo fixed the fence at the cottage.");
    const answer = await generateRAGAnswer("What did Theo fix?");
    expect(answer.citations.map((c) => c.noteId)).toEqual(["n1"]);
    expect(answer.relatedNotes).toEqual([]);
  });

  it("an unverified summary of the latest notes lists those notes as Related — not as citations", async () => {
    mockSearch.mockResolvedValue([
      NOTE("n1", "Picked up oat milk and coffee beans for the office."),
      NOTE("n2", "The garden hose is stored in the blue shed."),
    ]);
    mockGenerate.mockResolvedValue("You spent the week planning a trip to Lisbon with Priya.");
    const answer = await generateRAGAnswer("Summarize my latest notes");
    expect(answer.text).toBe(UNVERIFIED_ANSWER_MESSAGE);
    expect(answer.citations).toEqual([]);
    expect(answer.relatedNotes.map((c) => c.noteId)).toEqual(["n1", "n2"]);
  });

  it("an unverified answer with nothing related says so truthfully", async () => {
    mockSearch.mockResolvedValue([NOTE("n1", "The garden hose is stored in the blue shed.")]);
    mockGenerate.mockResolvedValue("You parked the boat at Pier 4.");
    const answer = await generateRAGAnswer("Where did I park the boat?");
    expect(answer.citations).toEqual([]);
    expect(answer.relatedNotes).toEqual([]);
    expect(answer.text).toBe(UNVERIFIED_NO_RELATED_MESSAGE);
  });
});
