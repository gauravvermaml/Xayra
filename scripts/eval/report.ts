import type { Aggregate, CaseScore } from "./scoring";

/**
 * Terminal scorecard.
 *
 * Colour is applied only when stdout is a TTY, so piping to a file or a CI log
 * produces clean text rather than escape codes.
 */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code: string, text: string) => (useColor ? `[${code}m${text}[0m` : text);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);
const yellow = (t: string) => paint("33", t);
const dim = (t: string) => paint("2", t);
const bold = (t: string) => paint("1", t);

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Green at or above target, yellow within 15 points, red below. */
function ratedPct(value: number, target = 1): string {
  const text = pct(value);
  if (value >= target) return green(text);
  if (value >= target - 0.15) return yellow(text);
  return red(text);
}

function bar(value: number, width = 24): string {
  const filled = Math.round(value * width);
  const body = "█".repeat(filled) + dim("░".repeat(width - filled));
  return value >= 0.9 ? green(body) : value >= 0.6 ? yellow(body) : red(body);
}

export function renderReport(scores: CaseScore[], summary: Aggregate, modelLabel: string): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(bold("  Xayra extraction eval"));
  lines.push(dim(`  model: ${modelLabel}   temp: 0   grammar-constrained`));
  lines.push("");

  // Per-case detail, failures first so they are not scrolled off the top.
  const failing = scores.filter((s) => !s.passed);
  const passing = scores.filter((s) => s.passed);

  for (const score of [...failing, ...passing]) {
    const mark = score.passed ? green("PASS") : red("FAIL");
    const timing = dim(`${(score.durationMs / 1000).toFixed(1)}s`);
    const tokens = score.outputTokens === null ? dim("?") : dim(`${score.outputTokens}t`);
    lines.push(`  ${mark}  ${score.id.padEnd(16)} ${dim(score.category.padEnd(14))} F1 ${pct(score.f1).padStart(6)}  ${tokens.padStart(6)}  ${timing}`);
    for (const failure of score.failures) {
      lines.push(`        ${red("·")} ${failure}`);
    }
  }

  lines.push("");
  lines.push(bold("  By category"));
  for (const cat of summary.byCategory) {
    const rate = cat.total === 0 ? 0 : cat.passed / cat.total;
    lines.push(
      `    ${cat.category.padEnd(16)} ${bar(rate)}  ${String(cat.passed).padStart(2)}/${String(cat.total).padEnd(2)}  F1 ${pct(cat.macroF1).padStart(6)}`
    );
  }

  lines.push("");
  lines.push(bold("  Summary"));
  lines.push(`    Pass rate            ${ratedPct(summary.passRate)}   ${dim(`(${summary.passed}/${summary.total})`)}`);
  lines.push(`    Schema compliance    ${ratedPct(summary.schemaComplianceRate)}`);
  lines.push(`    Macro F1             ${ratedPct(summary.macroF1)}`);
  lines.push(
    `    Date resolution      ${summary.dateAccuracy === null ? dim("n/a") : ratedPct(summary.dateAccuracy)}`
  );
  lines.push(`    Negative constraints ${ratedPct(summary.negativeConstraintRate)}`);
  lines.push(
    `    Mean output tokens   ${summary.meanOutputTokens === null ? dim("n/a") : summary.meanOutputTokens.toFixed(0)}`
  );
  lines.push(dim(`    Wall clock           ${(summary.totalDurationMs / 1000).toFixed(1)}s`));
  lines.push("");

  return lines.join("\n");
}
