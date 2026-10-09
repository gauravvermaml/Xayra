/**
 * Compares models on the 50-question RAG set (ragComparisonCorpus.ts) with
 * identical evidence per question: temporal questions retrieve through the
 * production path (period → event-date eligibility → context), others use the
 * case's fixed retrieved set. Same prompt builder, same post-generation path
 * as rag.ts, generation through the corrected byte-exact harness.
 *
 *   npx tsx scripts/eval/runRagComparison.ts --out <dir>
 *
 * Measures, per answer: factual correctness, temporal interpretation (temporal
 * questions), unsupported embellishment (heuristic: content words found in
 * neither the context nor the question — flagged for manual review, not
 * proof), repetition, third-person / first-person voice, unnecessary bullets
 * (bullets with one note in context), false refusals.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildNoteContext, finalizeAnswer, isKnownRefusal, truncateForContext } from "../../services/ai/ragFormatting";
import { buildPrompt, CHAT_TEMPLATE_STOP_TOKENS, setRagPromptMode, type RagPromptMode } from "../../services/ai/ragPrompt";
import {
  buildGroundedQuestion,
  classifyEventEvidence,
  detectEventVerification,
  questionTerms,
  rankNotesForTarget,
  resolveQueryTemporalTarget,
} from "../../services/ai/temporalResolver";
import { runCompletion } from "./llamaRunner";
import { CASES, NOW, VAULT, type RagComparisonCase, type Rubric, type VaultNote } from "./ragComparisonCorpus";

type ModelConfig = { label: string; model: string; promptMode: RagPromptMode; noThink: boolean };

type Row = {
  id: string;
  category: RagComparisonCase["category"];
  question: string;
  notesInContext: string[];
  groundedQuestion: string;
  context: string;
  raw: string;
  final: string;
  outcome: string;
  /** Why the app replaced the answer, when it did. */
  reasons: string[];
  factual: boolean;
  temporal: boolean | null;
  novelWords: string[];
  embellishmentFlag: boolean;
  repetition: boolean;
  thirdPerson: boolean;
  firstPerson: boolean;
  unnecessaryBullets: boolean;
  falseRefusal: boolean;
  durationMs: number;
  outputTokens: number | null;
};
type FlagKey = "factual" | "embellishmentFlag" | "repetition" | "thirdPerson" | "firstPerson" | "unnecessaryBullets" | "falseRefusal";

const CONFIGS: ModelConfig[] = [
  { label: "current fine-tuned, minimal prompt", model: "models/qwen-task-extractor-q4_k_m.gguf", promptMode: "minimal", noThink: false },
  { label: "Qwen3-1.7B, full prompt", model: "models/Qwen3-1.7B-Q4_K_M.gguf", promptMode: "full", noThink: true },
];
const PENALTIES = [1.0, 1.15];
const CONTEXT_NOTE_LIMIT = 3; // rag.ts
const EMPTY_CONTEXT = "--- NOTE CONTEXT ---\nNo relevant voice notes were found.";

const REFUSAL =
  /\b(no information|couldn'?t find|could not find|don'?t have (any )?(information|details)|do not have (any )?(information|details)|not mentioned|doesn'?t mention|does not mention|no mention|not specified|isn'?t specified|not provided|isn'?t mentioned|is not mentioned|no record|there is no|i'?m sorry)\b/i;
const THIRD_PERSON = /\bthe (speaker|user|person|author|narrator|writer|individual)\b|\b(he|she) (mentioned|said|noted|recorded|wrote)\b/i;
const FIRST_PERSON = /\b(I|I'm|I've|I'd|I'll)\b|\b(my|me|mine|we|our|us)\b/i;
const BULLETS = /^\s*(•|-|\*|\d+\.)\s/m;
const EMBELLISH_STOP = new Set(
  ("your you note notes noted mentioned mention mentions recorded record according which there about were have that this they their them then with from been " +
    "also what when where would could should into onto very much more some made make said says while after before being does didn't wasn't weren't don't " +
    "it's only just like such here these those than other over under each both during information details found find based compared comparison previous " +
    "year years day days time weather today yesterday tomorrow morning last next week weeks month around same quite really well good your's i'm you're " +
    "you've it was had has did can will his her hers him its our ours yes not there's that's what's specifically detail mention noting describe described " +
    "describes indicates indicate stated states state note's also however overall additionally currently since year's").split(/\s+/)
);

const matches = (text: string, needle: string) =>
  needle.startsWith("re:") ? new RegExp(needle.slice(3), "i").test(text) : text.toLowerCase().includes(needle.toLowerCase());
const satisfies = (text: string, rubric?: Rubric) => (rubric ?? []).every((group) => group.some((n) => matches(text, n)));
const violates = (text: string, forbidden?: string[]) => (forbidden ?? []).filter((n) => matches(text, n));

function novelWords(answer: string, context: string, question: string): string[] {
  const known = `${context} ${question}`.toLowerCase();
  const words = answer.toLowerCase().replace(/[’']s\b/g, "").match(/[a-z][a-z'’]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !EMBELLISH_STOP.has(w) && !known.includes(w)))];
}

function repeated(answer: string): boolean {
  const sentences = answer
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.toLowerCase().replace(/^\s*(•|-|\*|\d+\.)\s*/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 15);
  return new Set(sentences).size < sentences.length;
}

/** rag.ts's retrieval + context path: temporal questions rank the whole
 * vault with the production rankNotesForTarget (same truncated text as
 * getNotesForTarget); other questions use the case's fixed evidence. */
function retrieve(c: RagComparisonCase) {
  const target = resolveQueryTemporalTarget(c.question, NOW);
  const verification = detectEventVerification(c.question, NOW, target);
  const eventTerms = verification?.eventTerms ?? [];
  let notes: VaultNote[];
  if (target) {
    notes = rankNotesForTarget(
      VAULT.map((n) => ({ note: n, text: truncateForContext(n.content), createdAt: n.createdAt })),
      target,
      { question: questionTerms(c.question, NOW), event: eventTerms },
      CONTEXT_NOTE_LIMIT
    ).map((r) => r.note);
  } else {
    notes = (c.evidence ?? []).map((id) => VAULT.find((n) => n.id === id)!);
  }
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
  };
}

/** rag.ts's post-generation path — the same shared function. */
function appFinal(raw: string, r: ReturnType<typeof retrieve>): { final: string; outcome: string; reasons: string[] } {
  const result = finalizeAnswer({
    raw,
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
  return { final: result.text, outcome: result.outcome, reasons };
}

async function main() {
  const outArg = process.argv.indexOf("--out");
  const outDir = outArg !== -1 ? process.argv[outArg + 1] : ".";
  // --ids T7,T8   --config fine-tuned   (substring of a config label)
  const idsArg = process.argv.indexOf("--ids");
  const ids = idsArg !== -1 ? new Set(process.argv[idsArg + 1].split(",")) : null;
  const configArg = process.argv.indexOf("--config");
  const configFilter = configArg !== -1 ? process.argv[configArg + 1] : null;
  const cases = ids ? CASES.filter((c) => ids.has(c.id)) : CASES;
  const configs = configFilter ? CONFIGS.filter((c) => c.label.includes(configFilter)) : CONFIGS;
  const all: unknown[] = [];
  const lines: string[] = [];

  for (const cfg of configs) {
    setRagPromptMode(cfg.promptMode);
    for (const penalty of PENALTIES) {
      const rows: Row[] = [];
      for (const c of cases) {
        const r = retrieve(c);
        const prompt = buildPrompt(r.groundedQuestion, r.context, NOW) + (cfg.noThink ? "<think>\n\n</think>\n\n" : "");
        const gen = await runCompletion({ modelPath: cfg.model, prompt, contextSize: 4096, maxTokens: 256, stop: CHAT_TEMPLATE_STOP_TOKENS, repeatPenalty: penalty });
        const raw = gen.text.replace(/^<think>[\s\S]*?<\/think>\s*/, "").trim();
        const refused = isKnownRefusal(raw) || REFUSAL.test(raw);
        const factViolations = violates(raw, c.mustNotInclude);
        const factual = c.expectRefusal ? refused && factViolations.length === 0 : !refused && satisfies(raw, c.mustInclude) && factViolations.length === 0;
        const temporal =
          c.category === "temporal"
            ? !refused && satisfies(raw, c.periodMustInclude) && violates(raw, c.periodMustNotInclude).length === 0
            : null;
        const novel = novelWords(raw, r.context, c.question);
        const app = appFinal(gen.text, r);
        rows.push({
          id: c.id,
          category: c.category,
          question: c.question,
          notesInContext: r.included.map((n) => n.id),
          groundedQuestion: r.groundedQuestion,
          context: r.context,
          raw,
          ...app,
          factual,
          temporal,
          novelWords: novel,
          embellishmentFlag: novel.length >= 3,
          repetition: repeated(raw),
          thirdPerson: THIRD_PERSON.test(raw),
          firstPerson: FIRST_PERSON.test(raw),
          unnecessaryBullets: BULLETS.test(raw) && r.included.length <= 1,
          falseRefusal: !c.expectRefusal && refused,
          durationMs: gen.durationMs,
          outputTokens: gen.outputTokens,
        });
        process.stdout.write(".");
      }
      const n = rows.length;
      const temporalRows = rows.filter((x) => x.temporal !== null);
      const count = (k: FlagKey) => rows.filter((x) => x[k]).length;
      const summary = {
        config: cfg.label,
        penalty,
        factual: `${count("factual")}/${n}`,
        temporal: `${temporalRows.filter((x) => x.temporal).length}/${temporalRows.length}`,
        embellishmentFlags: count("embellishmentFlag"),
        repetition: count("repetition"),
        thirdPerson: count("thirdPerson"),
        firstPerson: count("firstPerson"),
        unnecessaryBullets: count("unnecessaryBullets"),
        falseRefusals: count("falseRefusal"),
        correctRefusals: `${rows.filter((x) => x.category === "unanswerable" && x.factual).length}/${rows.filter((x) => x.category === "unanswerable").length}`,
        avgMsPerAnswer: Math.round(rows.reduce((s, x) => s + x.durationMs, 0) / n),
        appOutcomes: rows.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.outcome]: (acc[x.outcome] ?? 0) + 1 }), {}),
        failedFactual: rows.filter((x) => !x.factual).map((x) => x.id),
        failedTemporal: temporalRows.filter((x) => !x.temporal).map((x) => x.id),
      };
      console.log(`\n${JSON.stringify(summary)}`);
      all.push({ summary, rows });
      lines.push(`\n######## ${cfg.label} | penalty ${penalty}`);
      for (const x of rows) {
        const flags = [
          x.factual ? "" : "FACT✗",
          x.temporal === false ? "TIME✗" : "",
          x.embellishmentFlag ? `EMB?${JSON.stringify(x.novelWords)}` : "",
          x.repetition ? "REPEAT" : "",
          x.thirdPerson ? "3RD" : "",
          x.firstPerson ? "1ST" : "",
          x.unnecessaryBullets ? "BULLETS" : "",
          x.falseRefusal ? "FALSE-REFUSAL" : "",
        ].filter(Boolean);
        const grounded = x.groundedQuestion !== x.question ? `\n   GROUNDED QUESTION: ${x.groundedQuestion}` : "";
        const context = x.context.split("\n").map((l) => `     | ${l}`).join("\n");
        lines.push(
          `${x.id} [${x.notesInContext.join(",")}] ${x.question}${grounded}\n   CONTEXT:\n${context}\n` +
            `   RAW:   ${JSON.stringify(x.raw)}\n   FINAL: ${JSON.stringify(x.final)}  [${x.outcome}]  ${flags.join(" ")}` +
            (x.reasons.length > 0 ? `
   WHY:   ${x.reasons.join(" | ")}` : "")
        );
      }
    }
  }
  await writeFile(join(outDir, "rag-comparison.json"), JSON.stringify(all, null, 2), "utf8");
  await writeFile(join(outDir, "rag-comparison-answers.txt"), lines.join("\n"), "utf8");
}

void main();
