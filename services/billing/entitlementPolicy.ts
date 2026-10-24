/**
 * Xayra Premium access — pure, so every rule is tested on its own.
 *
 * RevenueCat verifies purchases on its servers and the SDK caches the last
 * CustomerInfo on the phone; this decides what that information allows,
 * including while the phone is offline:
 *
 *  - Access needs a "premium" entitlement that RevenueCat reported active.
 *    Expiry, cancellation, refunds and revocations are all reflected there
 *    (an entitlement RevenueCat no longer lists is simply inactive).
 *  - It never runs past the entitlement's known expiration date. Google's
 *    grace period is included: RevenueCat extends that date while a renewal
 *    payment is being retried. A free trial is just an expiration date from
 *    Google — nothing here can extend or restart one.
 *  - Offline, previously verified access lasts at most OFFLINE_ALLOWANCE_MS
 *    after the server time of the last successful check.
 *  - "Now" is never earlier than the newest moment already observed, so
 *    moving the device clock back gains nothing; moving it forward only
 *    ends access sooner, until the next check brings fresh server time.
 *  - A response RevenueCat's signature check marks as FAILED is not trusted.
 */

export const PREMIUM_ENTITLEMENT = "premium";
export const OFFLINE_ALLOWANCE_MS = 7 * 24 * 60 * 60 * 1000;
/** A check older than this counts as "offline" in the status shown. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/** The part of RevenueCat's CustomerInfo this needs, structurally. */
export type CustomerInfoLike = {
  requestDate: string;
  managementURL: string | null;
  entitlements: {
    active: Record<string, EntitlementLike | undefined>;
    all: Record<string, EntitlementLike | undefined>;
    verification?: string;
  };
};

export type EntitlementLike = {
  isActive: boolean;
  willRenew: boolean;
  periodType: string;
  expirationDate: string | null;
  billingIssueDetectedAt: string | null;
  verification?: string;
};

/** What the last check said about Premium. All times are ms since epoch. */
export type EntitlementSnapshot = {
  /** Server time of the check (CustomerInfo.requestDate). */
  verifiedAt: number;
  /** RevenueCat listed the entitlement as active. */
  active: boolean;
  /** Known end of access; null only for non-expiring access. */
  expiresAt: number | null;
  willRenew: boolean;
  trial: boolean;
  /** A renewal payment is failing (Google's grace period while active). */
  billingIssue: boolean;
  /** Ever had Premium (an expired entitlement is still listed under "all"). */
  everSubscribed: boolean;
  untrusted: boolean;
  managementUrl: string | null;
};

export type PremiumState = "trial" | "active" | "cancelled" | "billing-issue" | "expired" | "none" | "unverified";

export type Access = {
  premium: boolean;
  state: PremiumState;
  /** When current access ends (expiry or the offline limit), if premium. */
  until: number | null;
  /** The status comes from a cached check (no recent server contact). */
  offline: boolean;
  /** Server time of the check the decision used. */
  checkedAt: number | null;
  /** The subscription's own end date (renewal or end of access), if known. */
  expiresAt: number | null;
};

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function snapshotFrom(info: CustomerInfoLike): EntitlementSnapshot | null {
  const verifiedAt = time(info.requestDate);
  if (verifiedAt === null) return null;
  const active = info.entitlements.active[PREMIUM_ENTITLEMENT];
  const any = active ?? info.entitlements.all[PREMIUM_ENTITLEMENT];
  return {
    verifiedAt,
    active: Boolean(active?.isActive),
    expiresAt: time(any?.expirationDate ?? null),
    willRenew: Boolean(any?.willRenew),
    trial: any?.periodType === "TRIAL",
    billingIssue: Boolean(any?.billingIssueDetectedAt),
    everSubscribed: Boolean(any),
    untrusted: any?.verification === "FAILED" || info.entitlements.verification === "FAILED",
    managementUrl: info.managementURL,
  };
}

/** The clock time to judge by: never earlier than anything already observed. */
export function effectiveNow(now: number, lastObservedAt: number | null, verifiedAt: number | null): number {
  return Math.max(now, lastObservedAt ?? -Infinity, verifiedAt ?? -Infinity);
}

export function decideAccess(input: { snapshot: EntitlementSnapshot | null; now: number; lastObservedAt: number | null }): Access {
  const { snapshot } = input;
  if (!snapshot) return { premium: false, state: "none", until: null, offline: false, checkedAt: null, expiresAt: null };
  const now = effectiveNow(input.now, input.lastObservedAt, snapshot.verifiedAt);
  const offline = now - snapshot.verifiedAt > STALE_AFTER_MS;
  const base = { offline, checkedAt: snapshot.verifiedAt, expiresAt: snapshot.expiresAt };
  if (snapshot.untrusted) return { ...base, premium: false, state: "unverified", until: null };
  if (!snapshot.active) return { ...base, premium: false, state: snapshot.everSubscribed ? "expired" : "none", until: null };

  const until = Math.min(snapshot.expiresAt ?? Infinity, snapshot.verifiedAt + OFFLINE_ALLOWANCE_MS);
  if (now >= until) {
    // Past the known expiry, or past the offline limit: a check is needed.
    const expired = snapshot.expiresAt !== null && now >= snapshot.expiresAt;
    return { ...base, premium: false, state: expired ? "expired" : "active", until: null, offline: true };
  }
  const state: PremiumState = snapshot.billingIssue ? "billing-issue" : snapshot.trial ? "trial" : snapshot.willRenew ? "active" : "cancelled";
  return { ...base, premium: true, state, until };
}

/**
 * The persisted clock after a decision: the newest observed moment, reset
 * to a newer check's server time (so a clock that was set far ahead and then
 * corrected doesn't keep Premium locked once the app has checked again).
 */
export function nextClock(
  clock: { lastObservedAt: number | null; lastVerifiedAt: number | null },
  now: number,
  verifiedAt: number | null
): { lastObservedAt: number; lastVerifiedAt: number | null } {
  if (verifiedAt !== null && verifiedAt > (clock.lastVerifiedAt ?? -Infinity)) {
    return { lastObservedAt: Math.max(verifiedAt, Math.min(now, verifiedAt + STALE_AFTER_MS)), lastVerifiedAt: verifiedAt };
  }
  return { lastObservedAt: Math.max(now, clock.lastObservedAt ?? -Infinity), lastVerifiedAt: clock.lastVerifiedAt };
}
