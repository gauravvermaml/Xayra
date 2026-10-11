/**
 * Privacy rule: no production log prints note, transcript, Ask or to-do
 * text. Diagnostics carry metadata only (lengths, counts, flags).
 */
import * as fs from "fs";
import * as path from "path";

import { redactForLog, wordCount } from "../services/logging/redact";

describe("redactForLog", () => {
  it("replaces every string with its length, keeping the shape", () => {
    expect(
      redactForLog([{ task: "Call Theo about the roller", date_phrase: "next Friday", recurrence: null, confidence: 0.9 }])
    ).toEqual([{ task: "<26 chars>", date_phrase: "<11 chars>", recurrence: null, confidence: 0.9 }]);
  });

  it("never lets text through nested values", () => {
    const out = JSON.stringify(redactForLog({ a: { b: ["Penrith Hardware fence"] }, n: 3, ok: true }));
    expect(out).not.toMatch(/Penrith|fence/);
    expect(out).toContain('"n":3');
  });

  it("counts words without exposing them", () => {
    expect(wordCount("  Theo came by  ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("production source has no personal text in logs", () => {
  const ROOTS = ["app", "components", "services", "hooks"];
  // Variables that hold the user's words in this codebase.
  const TEXT_VARS =
    /\$\{\s*(transcript|task|text|query|content|datePhrase|rawText|rawNoteText|userQuery|answer|answerText|prompt|item\.task|note\.content|note\.transcript)\s*\}/;
  // Logging an object that holds the user's words wholesale.
  const TEXT_OBJECT_ARGS = /,\s*(parsed|item|transcript|note|todo\.task|answer)\s*[,)]/;

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(__dirname, "..", root))) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/console\.(log|warn|error|info|debug)\(([\s\S]*?)\);/g)) {
        const call = `${match[2]})`; // keep the closing paren so a trailing object argument is checked too
        if (TEXT_VARS.test(call) || TEXT_OBJECT_ARGS.test(call)) {
          offenders.push(`${path.relative(path.join(__dirname, ".."), file)}: ${call.slice(0, 120)}`);
        }
      }
    }
  }

  it("no console call interpolates or dumps note/transcript/to-do text", () => {
    expect(offenders).toEqual([]);
  });
});
