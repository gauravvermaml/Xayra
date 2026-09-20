import type { ExtractedToDo } from "../../services/ai/extractionLogic";

/**
 * Scoring for the Tier 2 harness.
 *
 * Deliberately separate from the runner so every metric is a pure function of
 * (expected, actual) and can be unit-tested without invoking a model.
 */

export type ExpectedTask = {
  task: string;
  actionDate?: string;
  recurrence?: string;
};

/** A note supplied as retrieval context to a RAG case. */
export type ContextNote = {
  content: string;
  /** Unix seconds. Fixed per case so "[Recorded: ...]" framing is stable. */
  createdAt: number;
};

export type EvalCase = {
  id: string;
  category: string;
  /** Defaults to "extraction". RAG cases take a query plus context notes and
   * are scored on grounding rather than slot F1. */
  kind?: "extraction" | "rag";
  /** RAG only: the user's question. */
  query?: string;
  /** RAG only: the notes retrieval would have supplied. An empty array is the
   * zero-context refusal case. */
  contexts?: ContextNote[];
  /** Frozen reference date, so relative phrases resolve identically on every
   * run regardless of when the suite is executed. */
  today: string;
  note: string;
  expect: {
    tasks: ExpectedTask[];
    /** Substrings that must NOT appear anywhere in the output — the
     * negative-constraint assertion. Catches the failure shape where the model
     * invents a task from a third party's action. */
    mustNotContain?: string[];
    /** Optional ceiling on generated tokens for this case. */
    maxOutputTokens?: number;
    /** RAG only: substrings that MUST appear. Used as the faithfulness probe —
     * the specific facts that are actually present in the supplied contexts. */
    mustContain?: string[];
    /** RAG only: true when the right answer is to decline because nothing
     * relevant was retrieved. */
    expectRefusal?: boolean;
  };
};

export type CaseScore = {
  id: string;
  category: string;
  kind: "extraction" | "rag";
  /** Output parsed as JSON in the shape the schema requires. */
  schemaValid: boolean;
  precision: number;
  recall: number;
  f1: number;
  /** Fraction of correctly-matched tasks whose resolved date is exactly right.
   * `null` when no expected task carried a date. */
  dateAccuracy: number | null;
  /** False when a forbidden substring appeared. */
  negativeConstraintsHeld: boolean;
  /** RAG only; `null` for extraction cases, which have no sources to ground
   * against. Combines faithfulness (required facts present, fabricated facts
   * absent) with refusal correctness. */
  grounding: number | null;
  outputTokens: number | null;
  withinTokenBudget: boolean;
  durationMs: number;
  passed: boolean;
  failures: string[];
};

/**
 * Task-text comparison. Exact string equality would fail on cosmetic variation
 * ("Book a table" vs "book a table.") that nobody would call a wrong answer,
 * so comparison is on lowercased alphanumeric content.
 *
 * This is deliberately lenient about WORDING and strict about everything else
 * — dates, counts and forbidden content are all asserted exactly. A metric
 * that punished "Call dentist" vs "Call the dentist" would generate noise that
 * trains you to ignore the scorecard.
 */
function normalizeTaskText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tasksMatch(expected: ExpectedTask, actual: ExtractedToDo): boolean {
  return normalizeTaskText(expected.task) === normalizeTaskText(actual.task);
}

/**
 * Greedy one-to-one pairing between expected and actual tasks. Each actual task
 * can satisfy at most one expected task, so duplicate emissions of the same
 * task count as false positives rather than silently scoring twice.
 */
function pairTasks(
  expected: ExpectedTask[],
  actual: ExtractedToDo[]
): { pairs: Array<{ expected: ExpectedTask; actual: ExtractedToDo }>; unmatchedExpected: ExpectedTask[]; unmatchedActual: ExtractedToDo[] } {
  const remaining = [...actual];
  const pairs: Array<{ expected: ExpectedTask; actual: ExtractedToDo }> = [];
  const unmatchedExpected: ExpectedTask[] = [];

  for (const exp of expected) {
    const index = remaining.findIndex((act) => tasksMatch(exp, act));
    if (index === -1) {
      unmatchedExpected.push(exp);
    } else {
      pairs.push({ expected: exp, actual: remaining[index] });
      remaining.splice(index, 1);
    }
  }

  return { pairs, unmatchedExpected, unmatchedActual: remaining };
}

function f1Score(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function scoreCase(
  evalCase: EvalCase,
  actual: ExtractedToDo[] | null,
  rawOutput: string,
  outputTokens: number | null,
  durationMs: number
): CaseScore {
  const failures: string[] = [];
  const schemaValid = actual !== null;

  if (!schemaValid) {
    failures.push("output did not parse as a valid task array");
  }

  const resolved = actual ?? [];
  const { pairs, unmatchedExpected, unmatchedActual } = pairTasks(evalCase.expect.tasks, resolved);

  const truePositives = pairs.length;
  // An empty expectation that is correctly met scores 1, not 0 — a case whose
  // right answer is "extract nothing" is a pass, not a total miss.
  const precision = resolved.length === 0 ? (evalCase.expect.tasks.length === 0 ? 1 : 0) : truePositives / resolved.length;
  const recall = evalCase.expect.tasks.length === 0 ? 1 : truePositives / evalCase.expect.tasks.length;

  for (const missed of unmatchedExpected) {
    failures.push(`missed task: "${missed.task}"`);
  }
  for (const extra of unmatchedActual) {
    failures.push(`spurious task: "${extra.task}"`);
  }

  // Date accuracy is measured only over tasks that were actually matched —
  // otherwise a missed task would be punished twice, once as a recall miss and
  // again as a date failure, distorting both numbers.
  const datedPairs = pairs.filter((p) => p.expected.actionDate !== undefined);
  let dateAccuracy: number | null = null;
  if (datedPairs.length > 0) {
    const correct = datedPairs.filter((p) => p.actual.actionDate === p.expected.actionDate);
    dateAccuracy = correct.length / datedPairs.length;
    for (const pair of datedPairs) {
      if (pair.actual.actionDate !== pair.expected.actionDate) {
        failures.push(`date for "${pair.expected.task}": expected ${pair.expected.actionDate}, got ${pair.actual.actionDate}`);
      }
    }
  }

  const forbidden = evalCase.expect.mustNotContain ?? [];
  const haystack = `${rawOutput} ${resolved.map((t) => t.task).join(" ")}`.toLowerCase();
  const violated = forbidden.filter((needle) => haystack.includes(needle.toLowerCase()));
  for (const needle of violated) {
    failures.push(`forbidden content present: "${needle}"`);
  }

  const budget = evalCase.expect.maxOutputTokens;
  const withinTokenBudget = budget === undefined || outputTokens === null || outputTokens <= budget;
  if (!withinTokenBudget) {
    failures.push(`output ${outputTokens} tokens exceeds budget ${budget}`);
  }

  return {
    id: evalCase.id,
    category: evalCase.category,
    kind: "extraction",
    grounding: null,
    schemaValid,
    precision,
    recall,
    f1: f1Score(precision, recall),
    dateAccuracy,
    negativeConstraintsHeld: violated.length === 0,
    outputTokens,
    withinTokenBudget,
    durationMs,
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Whether an answer declined to answer from the supplied context.
 *
 * Deliberately NOT an exact match against the prompt's mandated line. The
 * model paraphrases it in practice — "There is no note about renewing your
 * passport" instead of "I couldn't find any details about that in your notes"
 * — and nothing in the app parses that string, so a paraphrase is a
 * prompt-adherence nit, not a grounding failure. Scoring it exactly would
 * fail answers that are behaviourally correct.
 */
const REFUSAL_PATTERNS = [
  /couldn'?t find/i,
  /could not find/i,
  /don'?t have (?:any )?(?:notes?|details|information)/i,
  /no (?:notes?|details|information|mention)/i,
  /nothing (?:in your notes|about that)/i,
  /not find any/i,
];

export function looksLikeRefusal(answer: string): boolean {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(answer));
}

/**
 * Scores a RAG answer on grounding rather than slot extraction.
 *
 * Two properties, both deterministic:
 *
 *  a) FAITHFULNESS — every required fact (drawn from the supplied contexts)
 *     appears, and no forbidden string does. The forbidden list is where
 *     fabrication is caught: a distractor note's subject, or a detail that
 *     exists nowhere in the context.
 *
 *  b) REFUSAL / BOUNDARY — when the contexts contain nothing relevant, the
 *     answer must decline rather than invent. Equally, a case WITH relevant
 *     context must not refuse.
 *
 * This is a proxy for faithfulness, not a proof of it. True entailment
 * checking needs a judge model, which would add a second thing that can be
 * wrong and a cloud dependency this project deliberately avoids. Substring
 * probes over a fixed corpus catch the failure shapes actually observed
 * on-device while staying fast and reproducible.
 */
export function scoreRagCase(
  evalCase: EvalCase,
  answer: string,
  outputTokens: number | null,
  durationMs: number
): CaseScore {
  const failures: string[] = [];
  const lower = answer.toLowerCase();

  const required = evalCase.expect.mustContain ?? [];
  const missing = required.filter((needle) => !lower.includes(needle.toLowerCase()));
  for (const needle of missing) {
    failures.push(`missing grounded fact: "${needle}"`);
  }

  const forbidden = evalCase.expect.mustNotContain ?? [];
  const violated = forbidden.filter((needle) => lower.includes(needle.toLowerCase()));
  for (const needle of violated) {
    failures.push(`hallucinated / leaked content: "${needle}"`);
  }

  const refused = looksLikeRefusal(answer);
  const shouldRefuse = evalCase.expect.expectRefusal === true;
  let refusalCorrect = true;
  if (shouldRefuse && !refused) {
    refusalCorrect = false;
    failures.push("should have declined — no relevant context was supplied");
  } else if (!shouldRefuse && refused && required.length > 0) {
    refusalCorrect = false;
    failures.push("declined despite relevant context being supplied");
  }

  // Three equally weighted components, so a case that gets two of three right
  // scores 0.67 rather than collapsing to pass/fail.
  const components = [
    required.length === 0 ? 1 : (required.length - missing.length) / required.length,
    forbidden.length === 0 ? 1 : (forbidden.length - violated.length) / forbidden.length,
    refusalCorrect ? 1 : 0,
  ];
  const grounding = components.reduce((a, b) => a + b, 0) / components.length;

  const budget = evalCase.expect.maxOutputTokens;
  const withinTokenBudget = budget === undefined || outputTokens === null || outputTokens <= budget;
  if (!withinTokenBudget) {
    failures.push(`output ${outputTokens} tokens exceeds budget ${budget}`);
  }

  return {
    id: evalCase.id,
    category: evalCase.category,
    kind: "rag",
    grounding,
    // Slot metrics do not apply to a prose answer; reported as the grounding
    // score so category roll-ups stay comparable rather than reading as zero.
    schemaValid: true,
    precision: grounding,
    recall: grounding,
    f1: grounding,
    dateAccuracy: null,
    negativeConstraintsHeld: violated.length === 0,
    outputTokens,
    withinTokenBudget,
    durationMs,
    passed: failures.length === 0,
    failures,
  };
}

export type Aggregate = {
  total: number;
  passed: number;
  passRate: number;
  schemaComplianceRate: number;
  macroF1: number;
  dateAccuracy: number | null;
  negativeConstraintRate: number;
  meanOutputTokens: number | null;
  /** `null` when the run contained no RAG cases. */
  grounding: number | null;
  totalDurationMs: number;
  byCategory: Array<{ category: string; total: number; passed: number; macroF1: number }>;
};

export function aggregate(scores: CaseScore[]): Aggregate {
  const total = scores.length;
  const passed = scores.filter((s) => s.passed).length;

  const dated = scores.filter((s) => s.dateAccuracy !== null);
  const tokenCounts = scores.map((s) => s.outputTokens).filter((t): t is number => t !== null);

  const categories = [...new Set(scores.map((s) => s.category))].sort();
  const byCategory = categories.map((category) => {
    const inCategory = scores.filter((s) => s.category === category);
    return {
      category,
      total: inCategory.length,
      passed: inCategory.filter((s) => s.passed).length,
      macroF1: inCategory.reduce((sum, s) => sum + s.f1, 0) / inCategory.length,
    };
  });

  return {
    total,
    passed,
    passRate: total === 0 ? 0 : passed / total,
    schemaComplianceRate: total === 0 ? 0 : scores.filter((s) => s.schemaValid).length / total,
    macroF1: total === 0 ? 0 : scores.reduce((sum, s) => sum + s.f1, 0) / total,
    dateAccuracy: dated.length === 0 ? null : dated.reduce((sum, s) => sum + (s.dateAccuracy ?? 0), 0) / dated.length,
    negativeConstraintRate: total === 0 ? 0 : scores.filter((s) => s.negativeConstraintsHeld).length / total,
    meanOutputTokens: tokenCounts.length === 0 ? null : tokenCounts.reduce((a, b) => a + b, 0) / tokenCounts.length,
    grounding: (() => {
      const grounded = scores.filter((s) => s.grounding !== null);
      return grounded.length === 0
        ? null
        : grounded.reduce((sum, s) => sum + (s.grounding ?? 0), 0) / grounded.length;
    })(),
    totalDurationMs: scores.reduce((sum, s) => sum + s.durationMs, 0),
    byCategory,
  };
}
