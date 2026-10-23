/**
 * Xayra Premium access rules (services/billing/entitlementPolicy.ts) —
 * subscription states, the seven-day offline allowance and clock changes.
 * Synthetic RevenueCat CustomerInfo shapes only.
 */
import {
  decideAccess,
  nextClock,
  OFFLINE_ALLOWANCE_MS,
  snapshotFrom,
  type CustomerInfoLike,
  type EntitlementLike,
} from "../services/billing/entitlementPolicy";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function info(entitlement: Partial<EntitlementLike> | null, opts: { at?: number; active?: boolean; verification?: string } = {}): CustomerInfoLike {
  const e: EntitlementLike | null = entitlement
    ? { isActive: true, willRenew: true, periodType: "NORMAL", expirationDate: iso(T0 + 30 * DAY), billingIssueDetectedAt: null, ...entitlement }
    : null;
  const active = opts.active ?? (e?.isActive ?? false);
  return {
    requestDate: iso(opts.at ?? T0),
    managementURL: "https://play.google.com/store/account/subscriptions?package=x",
    entitlements: { active: e && active ? { premium: e } : {}, all: e ? { premium: e } : {}, verification: opts.verification },
  };
}

const decide = (i: CustomerInfoLike, now: number, lastObservedAt: number | null = null) =>
  decideAccess({ snapshot: snapshotFrom(i), now, lastObservedAt });

describe("subscription states (online, just checked)", () => {
  it("trial: premium until the trial's expiration", () => {
    const a = decide(info({ periodType: "TRIAL", expirationDate: iso(T0 + 30 * DAY) }), T0);
    expect(a).toMatchObject({ premium: true, state: "trial", offline: false });
    expect(a.expiresAt).toBe(T0 + 30 * DAY);
  });

  it("active and renewing", () => {
    expect(decide(info({}), T0)).toMatchObject({ premium: true, state: "active" });
  });

  it("cancelled but still within the paid period: premium until it ends", () => {
    expect(decide(info({ willRenew: false }), T0)).toMatchObject({ premium: true, state: "cancelled" });
  });

  it("grace period (payment retrying): still premium, flagged", () => {
    expect(decide(info({ billingIssueDetectedAt: iso(T0 - DAY), expirationDate: iso(T0 + 6 * DAY) }), T0)).toMatchObject({
      premium: true,
      state: "billing-issue",
    });
  });

  it("account hold / expired / refunded / revoked: RevenueCat no longer lists it active → no premium", () => {
    expect(decide(info({ isActive: false, expirationDate: iso(T0 - DAY) }), T0)).toMatchObject({ premium: false, state: "expired" });
  });

  it("never subscribed", () => {
    expect(decide(info(null), T0)).toMatchObject({ premium: false, state: "none" });
  });

  it("a response whose signature check FAILED is not trusted", () => {
    expect(decide(info({}, { verification: "FAILED" }), T0)).toMatchObject({ premium: false, state: "unverified" });
    expect(decide(info({ verification: "FAILED" }), T0)).toMatchObject({ premium: false, state: "unverified" });
  });

  it("no status at all (RevenueCat unreachable, nothing cached) → no premium", () => {
    expect(decideAccess({ snapshot: null, now: T0, lastObservedAt: null })).toMatchObject({ premium: false, state: "none" });
  });
});

describe("offline: the seven-day allowance from the last check", () => {
  const yearly = info({ expirationDate: iso(T0 + 300 * DAY) });

  it("previously verified access continues offline within seven days", () => {
    expect(decide(yearly, T0 + 6 * DAY)).toMatchObject({ premium: true, offline: true, until: T0 + OFFLINE_ALLOWANCE_MS });
  });

  it("ends after seven days without a check, even with a later expiration", () => {
    expect(decide(yearly, T0 + 7 * DAY)).toMatchObject({ premium: false, offline: true });
  });

  it("never runs past the known expiration date, offline", () => {
    const monthly = info({ expirationDate: iso(T0 + 3 * DAY) });
    expect(decide(monthly, T0 + 2 * DAY).premium).toBe(true);
    expect(decide(monthly, T0 + 3 * DAY)).toMatchObject({ premium: false, state: "expired" });
  });

  it("a cancelled subscription ends at its expiration, not seven days later", () => {
    const cancelled = info({ willRenew: false, expirationDate: iso(T0 + DAY) });
    expect(decide(cancelled, T0 + DAY + 1).premium).toBe(false);
  });

  it("a trial cannot be extended offline: it ends at the trial's expiration", () => {
    const trial = info({ periodType: "TRIAL", expirationDate: iso(T0 + 2 * DAY) });
    expect(decide(trial, T0 + 2 * DAY + 1).premium).toBe(false);
  });

  it("a status last seen inactive is never turned into access offline", () => {
    expect(decide(info({ isActive: false }), T0 + DAY).premium).toBe(false);
  });
});

describe("device clock changes", () => {
  const sub = info({ expirationDate: iso(T0 + 300 * DAY) });

  it("moving the clock back does not extend access", () => {
    // Last observed 8 days after the check; the clock now claims day 1.
    expect(decide(sub, T0 + DAY, T0 + 8 * DAY).premium).toBe(false);
  });

  it("moving the clock back before a trial's end does not restore the trial", () => {
    const trial = info({ periodType: "TRIAL", expirationDate: iso(T0 + 2 * DAY) });
    expect(decide(trial, T0 + DAY, T0 + 3 * DAY).premium).toBe(false);
  });

  it("a clock behind the server time counts from the server time", () => {
    expect(decide(sub, T0 - 30 * DAY).premium).toBe(true);
  });

  it("the persisted clock never moves backwards on its own…", () => {
    expect(nextClock({ lastObservedAt: T0 + 5 * DAY, lastVerifiedAt: T0 }, T0 + DAY, T0)).toEqual({
      lastObservedAt: T0 + 5 * DAY,
      lastVerifiedAt: T0,
    });
  });

  it("…but a newer check (server time) replaces a clock that had been set far ahead", () => {
    const next = nextClock({ lastObservedAt: T0 + 400 * DAY, lastVerifiedAt: T0 }, T0 + 400 * DAY, T0 + 10 * DAY);
    expect(next.lastVerifiedAt).toBe(T0 + 10 * DAY);
    expect(next.lastObservedAt).toBeLessThanOrEqual(T0 + 10 * DAY + 60 * 60 * 1000);
  });
});
