/**
 * Replays already-generated answers from a runRagComparison.ts output through
 * the production post-generation path (`finalizeAnswer`) — no model calls.
 * Measures what the validators do to answers whose correctness the rubric
 * already judged: rubric-correct answers the app now replaces (false
 * rejections) vs rubric-wrong answers it catches or misses.
 *
 * Fixed-evidence, non-temporal cases only — their context does not depend on
 * ranking, so the evidence rebuilt here is exactly what the model saw.
 *
 *   npx tsx scripts/eval/runRelationshipSweep.ts <dir containing rag-comparison.json>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildNoteContext, finalizeAnswer } from "../../services/ai/ragFormatting";
import { CASES, NOW, VAULT } from "./ragComparisonCorpus";

type Row = { id: string; raw: string; factual: boolean };
type Run = { summary: { config: string; penalty: number }; rows: Row[] };

const VALIDATOR_OUTCOMES = new Set([
  "date-rejected",
  "relationship-rejected",
  "verification-contradicted",
  "grounding-rejected",
  "unsupported-negation",
]);

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: runRelationshipSweep.ts <dir containing rag-comparison.json>");
    process.exit(1);
  }
  const runs = JSON.parse(readFileSync(join(dir, "rag-comparison.json"), "utf8")) as Run[];
  const fixed = new Map(CASES.filter((c) => c.evidence && c.category !== "temporal").map((c) => [c.id, c]));
  const tally = { answers: 0, correct: 0, correctRejected: 0, wrong: 0, wrongCaught: 0, modelRefused: 0 };
  const falseRejections: string[] = [];
  const caught: string[] = [];
  const missed: string[] = [];
  let validationMs = 0;

  for (const run of runs) {
    const tag = `${run.summary.config.slice(0, 12)} p${run.summary.penalty}`;
    for (const row of run.rows) {
      const c = fixed.get(row.id);
      if (!c?.evidence) continue;
      tally.answers++;
      const notes = c.evidence.map((id) => VAULT.find((n) => n.id === id)!);
      const built = buildNoteContext(notes.map((n) => ({ id: n.id, content: n.content, transcript: null, createdAt: n.createdAt })), null);
      const t0 = performance.now();
      const result = finalizeAnswer({
        raw: row.raw,
        notesIncluded: built.includedIndices.length,
        contextText: built.contextText,
        question: c.question,
        memories: built.memories,
        evidence: built.evidence,
        target: null,
        now: NOW,
        eventEvidence: null,
      });
      validationMs += performance.now() - t0;
      const rejected = VALIDATOR_OUTCOMES.has(result.outcome);
      const why = [
        ...(result.dateCheck?.status === "rejected" ? result.dateCheck.violations.map((v) => `unsupported date "${v}"`) : []),
        ...(result.relationships?.violations.map((v) => v.reason) ?? []),
        ...(result.reason ? [result.reason] : []),
      ].join(" | ");
      const line = `${tag} ${row.id} [${result.outcome}] ${JSON.stringify(row.raw).slice(0, 170)}${why ? `\n      ${why}` : ""}`;
      if (result.outcome === "model-refusal") tally.modelRefused++;
      if (row.factual) {
        tally.correct++;
        if (rejected) {
          tally.correctRejected++;
          falseRejections.push(line);
        }
      } else {
        tally.wrong++;
        if (rejected || result.outcome === "model-refusal") {
          tally.wrongCaught++;
          caught.push(line);
        } else missed.push(line);
      }
    }
  }

  console.log(`answers replayed: ${tally.answers} (model's own refusals: ${tally.modelRefused})`);
  console.log(`rubric-correct answers replaced by a validator: ${tally.correctRejected}/${tally.correct}`);
  console.log(`rubric-wrong answers not shown: ${tally.wrongCaught}/${tally.wrong}`);
  console.log(`validation cost: ${(validationMs / tally.answers).toFixed(2)} ms per answer (desktop)`);
  console.log(`\n--- rubric-correct answers rejected (inspect: false rejection or real catch?)\n  ${falseRejections.join("\n  ")}`);
  console.log(`\n--- rubric-wrong answers caught\n  ${caught.join("\n  ")}`);
  console.log(`\n--- rubric-wrong answers still shown\n  ${missed.join("\n  ")}`);
}

main();
