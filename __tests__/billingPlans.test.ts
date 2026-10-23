/**
 * Paywall plans from the RevenueCat offering (services/billing/plans.ts):
 * prices, periods and trials come from Google Play; monthly is the default.
 */
import { defaultPlan, planFromPackage, plansFromPackages, type PackageLike } from "../services/billing/plans";

const phase = (unit: string, value: number, formatted: string) => ({ billingPeriod: { unit, value }, price: { formatted } });
function pkg(packageType: string, price: string, period: [string, number], trial: [string, number] | null): PackageLike {
  return {
    identifier: `$rc_${packageType.toLowerCase()}`,
    packageType,
    product: {
      priceString: trial ? "Free" : price,
      subscriptionPeriod: null,
      defaultOption: { freePhase: trial ? phase(trial[0], trial[1], "Free") : null, fullPricePhase: phase(period[0], period[1], price) },
    },
  };
}

// Prices are invented and formatted the way Play would; the code never builds a price itself.
const OFFERING = [
  pkg("ANNUAL", "AU$79.99", ["YEAR", 1], ["MONTH", 1]),
  pkg("WEEKLY", "AU$3.49", ["WEEK", 1], ["MONTH", 1]),
  pkg("SIX_MONTH", "AU$44.99", ["MONTH", 6], ["MONTH", 1]),
  pkg("MONTHLY", "AU$9.99", ["MONTH", 1], ["MONTH", 1]),
];

describe("plans", () => {
  it("four plans in order, with Play's own price strings and periods", () => {
    expect(plansFromPackages(OFFERING).map((p) => [p.title, p.price, p.per])).toEqual([
      ["Weekly", "AU$3.49", "a week"],
      ["Monthly", "AU$9.99", "a month"],
      ["Every 6 months", "AU$44.99", "every 6 months"],
      ["Yearly", "AU$79.99", "a year"],
    ]);
  });

  it("monthly is selected by default", () => {
    expect(defaultPlan(plansFromPackages(OFFERING))?.kind).toBe("monthly");
  });

  it("the recurring price is shown, not the trial's 'Free' first phase", () => {
    expect(plansFromPackages(OFFERING).every((p) => p.price !== "Free")).toBe(true);
  });

  it("an eligible customer sees the free month and the full renewal terms", () => {
    const monthly = plansFromPackages(OFFERING).find((p) => p.kind === "monthly")!;
    expect(monthly.trial).toBe("1 month free");
    expect(monthly.terms).toBe("Free for 1 month, then AU$9.99 a month. Renews automatically until you cancel in Google Play.");
  });

  it("no free phase from Play (not eligible) → no trial is promised", () => {
    const plan = planFromPackage(pkg("MONTHLY", "AU$9.99", ["MONTH", 1], null))!;
    expect(plan.trial).toBeNull();
    expect(plan.terms).toBe("AU$9.99 a month. Renews automatically until you cancel in Google Play.");
  });

  it("missing products: only what Play returned is shown; none → empty (the paywall says plans aren't available)", () => {
    expect(plansFromPackages([OFFERING[3]]).map((p) => p.kind)).toEqual(["monthly"]);
    expect(plansFromPackages([])).toEqual([]);
    expect(defaultPlan([])).toBeNull();
  });

  it("unknown package types and packages without a period are ignored", () => {
    expect(planFromPackage({ ...OFFERING[0], packageType: "LIFETIME" })).toBeNull();
    expect(planFromPackage({ identifier: "x", packageType: "MONTHLY", product: { priceString: "AU$1", subscriptionPeriod: null, defaultOption: null } })).toBeNull();
  });

  it("falls back to the product's ISO period when no pricing phase is present", () => {
    const plan = planFromPackage({ identifier: "w", packageType: "WEEKLY", product: { priceString: "AU$3.49", subscriptionPeriod: "P1W", defaultOption: null } });
    expect(plan).toMatchObject({ price: "AU$3.49", per: "a week", trial: null });
  });
});
