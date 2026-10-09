/**
 * Editing an existing journal note: same id, same recorded time, corrected
 * text re-indexed for search, to-dos left alone.
 */
import { createFakeNotesDb } from "./support/fakeNotesDb";

const mockDbState = createFakeNotesDb();

jest.mock("../db/client", () => ({
  getRawDatabase: jest.fn(() => Promise.resolve(mockDbState.db)),
  isFtsAvailable: jest.fn(() => Promise.resolve(false)),
}));
jest.mock("../services/ai/embeddingModel", () => ({
  isEmbeddingModelDownloaded: jest.fn(() => Promise.resolve(true)),
}));
const mockGenerateEmbedding = jest.fn((text: string) => Promise.resolve([text.length, 0.5, 0.25]));
jest.mock("../services/ai/localEmbeddings", () => ({
  generateEmbeddingLocal: (text: string) => mockGenerateEmbedding(text),
}));
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0) }));
jest.mock("../services/ai/pipelineStage", () => ({ setPipelineStage: jest.fn() }));
const mockExtract = jest.fn(() => Promise.resolve([]));
jest.mock("../services/ai/transformationEngine", () => ({ extractToDosFromText: () => mockExtract() }));
jest.mock("../services/todos/todoManager", () => ({
  addToDo: jest.fn((input: Record<string, unknown>) => Promise.resolve({ id: "fake-todo-id", ...input })),
}));
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true, size: 999999 })),
  deleteAsync: jest.fn(() => Promise.resolve()),
}));
let mockNextId = 0;
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => `fake-id-${++mockNextId}`) }));

describe("updateNoteText — correcting an existing journal note", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbState.reset();
    mockNextId = 0;
  });

  it("updates the same note in place: same id, same created_at, new text and updated_at", async () => {
    const { createTextNote, updateNoteText } = require("../services/notes/noteManager");
    const original = await createTextNote("Theo came by to pick the vaccum.");
    const [before] = mockDbState.getRows();
    const createdAt = before.created_at;

    await updateNoteText(original.id, "  Theo came by to pick the vacuum.  ");

    const rows = mockDbState.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: original.id, created_at: createdAt, content: "Theo came by to pick the vacuum.", status: "embedded" });
    expect(rows[0].updated_at).toEqual(expect.any(Number));
  });

  it("re-embeds the corrected text, replacing the old vector", async () => {
    const { createTextNote, updateNoteText } = require("../services/notes/noteManager");
    const original = await createTextNote("short");
    await updateNoteText(original.id, "a much longer corrected note");

    const embeddings = mockDbState.getEmbeddings();
    expect(embeddings).toHaveLength(1);
    expect(JSON.parse(embeddings[0].embedding as string)[0]).toBe("a much longer corrected note".length);
  });

  it("drops the stale vector even when re-embedding fails, and leaves the note for retry", async () => {
    const { createTextNote, updateNoteText } = require("../services/notes/noteManager");
    const original = await createTextNote("original wording");
    mockGenerateEmbedding.mockRejectedValueOnce(new Error("embedding model unavailable"));

    await updateNoteText(original.id, "corrected wording");

    expect(mockDbState.getEmbeddings()).toHaveLength(0);
    expect(mockDbState.getRows()[0]).toMatchObject({ content: "corrected wording", status: "transcribed" });
  });

  it("replaces a voice note's transcript too, so the uncorrected wording is not kept", async () => {
    const { createVoiceNote, updateNoteText } = require("../services/notes/noteManager");
    const original = await createVoiceNote("file:///fake.wav", "buy milk and bred");
    await updateNoteText(original.id, "buy milk and bread");
    expect(mockDbState.getRows()[0]).toMatchObject({ content: "buy milk and bread", transcript: "buy milk and bread" });
  });

  it("never re-runs to-do extraction for an edit", async () => {
    const { createTextNote, updateNoteText } = require("../services/notes/noteManager");
    const original = await createTextNote("Remind me to call the plumber on Friday.");
    await new Promise((resolve) => setImmediate(resolve));
    const extractionsAfterCreate = mockExtract.mock.calls.length;

    await updateNoteText(original.id, "Remind me to call the electrician on Friday.");
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockExtract.mock.calls.length).toBe(extractionsAfterCreate);
  });

  it("refuses an empty edit and leaves the note unchanged", async () => {
    const { createTextNote, updateNoteText } = require("../services/notes/noteManager");
    const original = await createTextNote("keep me");
    await expect(updateNoteText(original.id, "   ")).rejects.toThrow(/can't be empty/);
    expect(mockDbState.getRows()[0].content).toBe("keep me");
  });
});
