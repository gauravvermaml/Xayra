/**
 * Keyword-search query building: punctuation can't smuggle a stopword in,
 * and apostrophe-less possessives match the name only when the vault's own
 * words say so.
 */
jest.mock("../db/client", () => ({ getRawDatabase: jest.fn(), isFtsAvailable: jest.fn(() => Promise.resolve(false)) }));
jest.mock("../services/ai/embeddingModel", () => ({ isEmbeddingModelDownloaded: jest.fn(() => Promise.resolve(true)) }));
jest.mock("../services/ai/localEmbeddings", () => ({ generateEmbeddingLocal: jest.fn() }));
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0) }));
jest.mock("../services/ai/pipelineStage", () => ({ setPipelineStage: jest.fn() }));
jest.mock("../services/ai/transformationEngine", () => ({ extractToDosFromText: jest.fn(() => Promise.resolve([])) }));
jest.mock("../services/todos/todoManager", () => ({ addToDo: jest.fn() }));
jest.mock("expo-file-system/legacy", () => ({ getInfoAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "id") }));

import { possessiveSearchVariants, queryWords, toFtsQuery } from "../services/notes/noteManager";

/** A vault whose notes contain exactly these words (case-insensitive). */
const vault = (...words: string[]) => {
  const set = new Set(words.map((w) => w.toLowerCase()));
  return async (word: string) => set.has(word.toLowerCase());
};

describe("keyword query — punctuation", () => {
  it("'about?' is the stopword 'about', not a search term (the on-device failure)", () => {
    expect(queryWords("What was Theos notes all about?")).toEqual(["What", "was", "Theos", "notes", "all", "about"]);
    expect(toFtsQuery("What was Theos notes all about?")).toBe('"Theos" OR "notes"');
  });

  it("strips surrounding punctuation only, keeping inner characters", () => {
    expect(queryWords('"(vacuum)," re-check e-mail!')).toEqual(["vacuum", "re-check", "e-mail"]);
  });
});

describe("keyword query — possessives", () => {
  it("'Theo's notes' searches Theo (the 's is unambiguous)", () => {
    expect(toFtsQuery("What were Theo's notes about?")).toBe('"Theo" OR "notes"');
  });

  it("'Theos notes' may match Theo — when the vault has Theo and no 'Theos'", async () => {
    const variants = await possessiveSearchVariants("What were Theos notes about?", vault("Theo", "vacuum", "notes"));
    expect(variants).toEqual(["Theo"]);
    expect(toFtsQuery("What were Theos notes about?", variants)).toBe('"Theos" OR "notes" OR "Theo"');
  });

  it("'James notes' never creates 'Jame'", async () => {
    expect(await possessiveSearchVariants("What were James notes about?", vault("James", "notes"))).toEqual([]);
    expect(await possessiveSearchVariants("What were James notes about?", vault("notes"))).toEqual([]);
  });

  it("'Chris meeting' never creates 'Chri'", async () => {
    expect(await possessiveSearchVariants("When is the Chris meeting?", vault("Chris", "meeting"))).toEqual([]);
    expect(await possessiveSearchVariants("When is the Chris meeting?", vault("meeting"))).toEqual([]);
  });

  it("leaves double-s names and lowercase words alone", async () => {
    expect(await possessiveSearchVariants("What did Ross say about the notes?", vault("Ros", "notes"))).toEqual([]);
    expect(await possessiveSearchVariants("what were the results", vault("result"))).toEqual([]);
  });
});
