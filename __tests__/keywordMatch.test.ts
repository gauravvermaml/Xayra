import { matchesKeywordSearch } from "../services/search/keywordMatch";

describe("matchesKeywordSearch", () => {
  describe("single keyword", () => {
    it("matches a plain substring, case-insensitively", () => {
      expect(matchesKeywordSearch("Call the carpenter about the fence", "carpenter")).toBe(true);
      expect(matchesKeywordSearch("Call the carpenter about the fence", "CARPENTER")).toBe(true);
      expect(matchesKeywordSearch("Meet the teacher after school", "teacher")).toBe(true);
    });

    it("trims surrounding whitespace on both the query and the match", () => {
      expect(matchesKeywordSearch("Call the carpenter", "  carpenter  ")).toBe(true);
    });

    it("matches a substring that isn't a whole word", () => {
      expect(matchesKeywordSearch("Renew the subscription", "script")).toBe(true);
    });
  });

  describe("'+' AND operator", () => {
    it("matches when every '+'-separated term is present, in any order", () => {
      expect(matchesKeywordSearch("Eli has soccer practice Tuesday", "soccer+eli")).toBe(true);
      expect(matchesKeywordSearch("Eli has soccer practice Tuesday", "eli+soccer")).toBe(true);
    });

    it("is case-insensitive across every term", () => {
      expect(matchesKeywordSearch("Eli has soccer practice Tuesday", "SOCCER+Eli")).toBe(true);
    });

    it("tolerates whitespace around the '+' separator", () => {
      expect(matchesKeywordSearch("Eli has soccer practice Tuesday", "soccer + eli")).toBe(true);
    });

    it("fails when only one of the terms is present", () => {
      expect(matchesKeywordSearch("Eli has a dentist appointment", "soccer+eli")).toBe(false);
      expect(matchesKeywordSearch("Book soccer practice for the kids", "soccer+eli")).toBe(false);
    });

    it("supports more than two AND terms", () => {
      expect(matchesKeywordSearch("Eli has soccer practice with coach Sam", "soccer+eli+coach")).toBe(true);
      expect(matchesKeywordSearch("Eli has soccer practice", "soccer+eli+coach")).toBe(false);
    });
  });

  describe("non-matching queries", () => {
    it("returns false, not an error or partial match, when nothing matches", () => {
      expect(matchesKeywordSearch("Call the dentist tomorrow", "carpenter")).toBe(false);
      expect(matchesKeywordSearch("Call the dentist tomorrow", "soccer+eli")).toBe(false);
    });

    it("returns false against an empty text with a real query", () => {
      expect(matchesKeywordSearch("", "carpenter")).toBe(false);
    });
  });

  describe("degenerate queries", () => {
    it("treats an empty or whitespace-only query as matching everything", () => {
      expect(matchesKeywordSearch("Anything at all", "")).toBe(true);
      expect(matchesKeywordSearch("Anything at all", "   ")).toBe(true);
    });

    it("treats a bare '+' (no real terms either side) as matching everything", () => {
      expect(matchesKeywordSearch("Anything at all", "+")).toBe(true);
      expect(matchesKeywordSearch("Anything at all", " + ")).toBe(true);
    });

    it("ignores an empty term from a trailing/leading '+'", () => {
      expect(matchesKeywordSearch("Eli has soccer practice", "soccer+")).toBe(true);
      expect(matchesKeywordSearch("Eli has soccer practice", "+soccer")).toBe(true);
    });
  });
});
