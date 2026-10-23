/**
 * The paywall's plans, built from the RevenueCat offering — pure, so the
 * wording is tested. Every price, period and trial comes from Google Play
 * through RevenueCat; nothing is hardcoded. A trial is shown only when Play
 * returned a free phase, which it does only for customers who are eligible.
 */

export type PlanKind = "weekly" | "monthly" | "six-month" | "yearly";

/** Display order; monthly is preselected (DEFAULT_PLAN). */
export const PLAN_ORDER: PlanKind[] = ["weekly", "monthly", "six-month", "yearly"];
export const DEFAULT_PLAN: PlanKind = "monthly";

const PACKAGE_KIND: Record<string, PlanKind> = { WEEKLY: "weekly", MONTHLY: "monthly", SIX_MONTH: "six-month", ANNUAL: "yearly" };
const TITLE: Record<PlanKind, string> = { weekly: "Weekly", monthly: "Monthly", "six-month": "Every 6 months", yearly: "Yearly" };

type PeriodLike = { unit: string; value: number };
type PhaseLike = { billingPeriod: PeriodLike | null; price: { formatted: string; amountMicros?: number } };

/** The part of a RevenueCat package this needs, structurally. */
export type PackageLike = {
  identifier: string;
  packageType: string;
  product: {
    priceString: string;
    subscriptionPeriod: string | null;
    defaultOption: { freePhase: PhaseLike | null; fullPricePhase: PhaseLike | null } | null;
  };
};

export type PlanOption = {
  kind: PlanKind;
  packageId: string;
  title: string;
  /** The recurring price, as Google Play formats it. */
  price: string;
  /** "a week", "a month", "every 6 months", "a year". */
  per: string;
  /** "1 month free" — only when Play offers this customer a free trial. */
  trial: string | null;
  /** The full terms shown before purchase. */
  terms: string;
};

const UNIT_WORD: Record<string, string> = { DAY: "day", WEEK: "week", MONTH: "month", YEAR: "year" };

function duration(p: PeriodLike): string | null {
  const word = UNIT_WORD[p.unit];
  if (!word || !(p.value > 0)) return null;
  return `${p.value} ${word}${p.value === 1 ? "" : "s"}`;
}

function every(p: PeriodLike): string | null {
  const word = UNIT_WORD[p.unit];
  if (!word || !(p.value > 0)) return null;
  return p.value === 1 ? `a ${word}` : `every ${p.value} ${word}s`;
}

/** ISO 8601 billing period ("P1M", "P6M", "P1W", "P1Y") as a period. */
function parseIso(iso: string | null): PeriodLike | null {
  const m = iso?.match(/^P(\d+)([DWMY])$/);
  if (!m) return null;
  return { value: Number(m[1]), unit: { D: "DAY", W: "WEEK", M: "MONTH", Y: "YEAR" }[m[2] as "D" | "W" | "M" | "Y"] };
}

export function planFromPackage(pkg: PackageLike): PlanOption | null {
  const kind = PACKAGE_KIND[pkg.packageType];
  if (!kind) return null;
  const full = pkg.product.defaultOption?.fullPricePhase ?? null;
  const period = full?.billingPeriod ?? parseIso(pkg.product.subscriptionPeriod);
  const per = period ? every(period) : null;
  const price = full?.price.formatted ?? pkg.product.priceString;
  if (!per || !price) return null;
  const free = pkg.product.defaultOption?.freePhase ?? null;
  const freeFor = free?.billingPeriod ? duration(free.billingPeriod) : null;
  const renews = "Renews automatically until you cancel in Google Play.";
  return {
    kind,
    packageId: pkg.identifier,
    title: TITLE[kind],
    price,
    per,
    trial: freeFor ? `${freeFor} free` : null,
    terms: freeFor ? `Free for ${freeFor}, then ${price} ${per}. ${renews}` : `${price} ${per}. ${renews}`,
  };
}

/** The four plans in display order; packages Play didn't return are left out. */
export function plansFromPackages(packages: PackageLike[]): PlanOption[] {
  const byKind = new Map<PlanKind, PlanOption>();
  for (const pkg of packages) {
    const plan = planFromPackage(pkg);
    if (plan && !byKind.has(plan.kind)) byKind.set(plan.kind, plan);
  }
  return PLAN_ORDER.flatMap((kind) => (byKind.has(kind) ? [byKind.get(kind)!] : []));
}

/** The plan selected when the paywall opens: monthly when available. */
export function defaultPlan(plans: PlanOption[]): PlanOption | null {
  return plans.find((p) => p.kind === DEFAULT_PLAN) ?? plans[0] ?? null;
}
