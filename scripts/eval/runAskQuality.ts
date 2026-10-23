/**
 * Ask-quality regression run over the synthetic set in askQualityCorpus.ts:
 * the production model, prompt, retrieval/context construction and the
 * shared finalizeAnswer path — the same code rag.ts runs on the phone.
 *
 *   npx tsx scripts/eval/runAskQuality.ts --out <dir> [--ids Q1,Q3]
 *
 * Per case it records the raw model answer, what the app shows and why an
 * answer was withheld. Scoring:
 *  - useful:       expect "answer", shown, satisfies mustInclude, no forbidden text
 *  - safe:         nothing forbidden is SHOWN (a withheld answer is always safe)
 *  - falseReject:  expect "answer", the raw answer satisfied the rubric, but it was withheld
 *  - fabricationShown: forbidden text shown, or an answer shown where it must be withheld
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildNoteContext, finalizeAnswer, isRecencyQuestion, truncateForContext, withinRecentWindow } from "../../services/ai/ragFormatting";
import { questionForModel } from "../../services/ai/relationshipGrounding";
import { buildPrompt, CHAT_TEMPLATE_STOP_TOKENS, setRagPromptMode } from "../../services/ai/ragPrompt";
import {
  buildGroundedQuestion,
  classifyEventEvidence,
  detectEventVerification,
  questionTerms,
  rankNotesForTarget,
  resolveQueryTemporalTarget,
} from "../../services/ai/temporalResolver";
import { runCompletion } from "./llamaRunner";
import { CASES, NOW, VAULT, type AskQualityCase, type Rubric, type VaultNote } from "./askQualityCorpus";

const MODEL = "models/qwen-task-extractor-q4_k_m.gguf";
const REPEAT_PENALTY = 1.15; // localLlama.ts
const CONTEXT_NOTE_LIMIT = 3; // rag.ts
const EMPTY_CONTEXT = "--- NOTE CONTEXT ---\nNo relevant voice notes were found.";

/** rag.ts's "…lately?" handling: the fixed evidence stands in for the
 * relevance candidates, then only recent notes are kept. */
function recencyFiltered(question: string, notes: VaultNote[]): VaultNote[] {
  return isRecencyQuestion(question) ? withinRecentWindow(notes, NOW).slice(0, CONTEXT_NOTE_LIMIT) : notes;
}

const matches = (text: string, needle: string) =>
  needle.startsWith("re:") ? new RegExp(needle.slice(3), "i").test(text) : text.toLowerCase().includes(needle.toLowerCase());
const satisfies = (text: string, rubric?: Rubric) => (rubric ?? []).every((group) => group.some((n) => matches(text, n)));
const forbidden = (text: string, list?: string[]) => (list ?? []).filter((n) => matches(text, n));

function retrieve(c: AskQualityCase) {
  const target = resolveQueryTemporalTarget(c.question, NOW);
  const verification = detectEventVerification(c.question, NOW, target);
  const eventTerms = verification?.eventTerms ?? [];
  const notes: VaultNote[] = target
    ? rankNotesForTarget(
        VAULT.map((n) => ({ note: n, text: truncateForContext(n.content), createdAt: n.createdAt })),
        target,
        { question: questionTerms(c.question, NOW), event: eventTerms },
        CONTEXT_NOTE_LIMIT
      ).map((r) => r.note)
    : recencyFiltered(c.question, (c.evidence ?? []).map((id) => VAULT.find((n) => n.id === id)!));
  const built =
    notes.length > 0 ? buildNoteContext(notes.map((n) => ({ id: n.id, content: n.content, transcript: null, createdAt: n.createdAt })), target, { eventTerms }) : null;
  const included = built ? built.includedIndices.map((i) => notes[i]) : [];
  const memories = built ? built.includedIndices.map((i) => built.memories[i]) : [];
  return {
    target,
    included,
    memories,
    evidence: built ? built.evidence : [],
    context: built && included.length > 0 ? built.contextText : EMPTY_CONTEXT,
    eventEvidence: verification && target ? classifyEventEvidence(memories, target, eventTerms) : null,
    groundedQuestion: verification ? buildGroundedQuestion(c.question, NOW) : c.question,
    modelQuestion: verification ? buildGroundedQuestion(c.question, NOW) : questionForModel(c.question, built ? built.evidence : [], NOW),
  };
}

export function scoreShown(c: AskQualityCase, raw: string, shown: string, outcome: string) {
  const isShown = outcome === "shown";
  const shownForbidden = isShown ? forbidden(shown, c.mustNotInclude) : [];
  const fabricationShown = shownForbidden.length > 0 || (c.expect === "withhold" && isShown && !/no information|couldn'?t|not (mentioned|recorded|specified)|don'?t (say|mention)/i.test(shown));
  const useful = c.expect === "answer" && isShown && satisfies(shown, c.mustInclude) && shownForbidden.length === 0;
  const rawGood = satisfies(raw, c.mustInclude) && forbidden(raw, c.mustNotInclude).length === 0;
  const falseReject = c.expect === "answer" && !isShown && rawGood;
  return { useful, fabricationShown, falseReject, shownForbidden, rawGood };
}

async function main() {
  const outArg = process.argv.indexOf("--out");
  const outDir = outArg !== -1 ? process.argv[outArg + 1] : ".";
  const idsArg = process.argv.indexOf("--ids");
  const ids = idsArg !== -1 ? new Set(process.argv[idsArg + 1].split(",")) : null;
  setRagPromptMode("minimal");
  type Row = { id: string; kind: string; expect: string; question: string; notes: string[]; raw: string; shown: string; outcome: string; reasons: string[]; durationMs: number } & ReturnType<typeof scoreShown>;
  const rows: Row[] = [];
  for (const c of ids ? CASES.filter((x) => ids.has(x.id)) : CASES) {
    const r = retrieve(c);
    const prompt = buildPrompt(r.modelQuestion, r.context, NOW);
    const gen = r.included.length > 0
      ? await runCompletion({ modelPath: MODEL, prompt, contextSize: 4096, maxTokens: 512, stop: CHAT_TEMPLATE_STOP_TOKENS, repeatPenalty: REPEAT_PENALTY })
      : { text: "", durationMs: 0, outputTokens: 0 };
    const result = finalizeAnswer({
      raw: gen.text,
      notesIncluded: r.included.length,
      contextText: r.context,
      question: r.groundedQuestion,
      memories: r.memories,
      evidence: r.evidence,
      target: r.target,
      now: NOW,
      eventEvidence: r.eventEvidence,
    });
    const reasons = [
      ...(result.reason ? [result.reason] : []),
      ...(result.dateCheck?.status === "rejected" ? result.dateCheck.violations.map((v) => `unsupported date "${v}"`) : []),
      ...(result.relationships?.violations.map((v) => `${v.reason} — "${v.statement}"`) ?? []),
    ];
    const score = scoreShown(c, gen.text, result.text, result.outcome);
    rows.push({ id: c.id, kind: c.kind, expect: c.expect, question: c.question, notes: r.included.map((n) => n.id), raw: gen.text.trim(), shown: result.text, outcome: result.outcome, reasons, durationMs: gen.durationMs, ...score });
    process.stdout.write(`${c.id}:${result.outcome}${score.useful ? "+" : ""}${score.fabricationShown ? "!" : ""}${score.falseReject ? "x" : ""} `);
  }
  const total = (k: "useful" | "fabricationShown" | "falseReject") => rows.filter((x) => x[k]).length;
  const summary = {
    cases: rows.length,
    expectAnswer: rows.filter((x) => x.expect === "answer").length,
    useful: total("useful"),
    falseReject: total("falseReject"),
    fabricationShown: total("fabricationShown"),
  };
  console.log(`\n${JSON.stringify(summary)}`);
  await writeFile(join(outDir, "ask-quality.json"), JSON.stringify({ summary, rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
