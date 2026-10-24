/**
 * Xayra Premium — the one place the app talks to RevenueCat.
 *
 * Privacy: RevenueCat gets only what subscriptions need. Customers are
 * anonymous (no logIn, no Xayra account), no customer attributes are ever
 * set, device-identifier collection is off and the advertising-ID permission
 * is blocked (app.json). Notes, recordings, transcripts, Ask questions,
 * reminders, calendar contents and backups never pass through here.
 * `__tests__/billingPrivacy.test.ts` scans for forbidden SDK calls.
 *
 * Access decisions come from entitlementPolicy.ts over RevenueCat's own
 * cached CustomerInfo (the SDK keeps the last one on the phone), with the
 * seven-day offline limit and a clock that never moves backwards.
 *
 * Free features never depend on this: only `ensurePremium` gates, and only
 * the premium actions call it. Nothing here ever deletes or locks data.
 */
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import { AppState } from "react-native";
import Purchases, { LOG_LEVEL, PURCHASES_ERROR_CODE, type PurchasesPackage } from "react-native-purchases";

import { isDevelopmentBuild } from "../ai/perf";
import { readPreferences, writePreferences } from "../settings/preferences";
import { decideAccess, nextClock, snapshotFrom, type Access, type CustomerInfoLike, type EntitlementSnapshot } from "./entitlementPolicy";
import { plansFromPackages, type PlanOption } from "./plans";

export type PremiumFeature = "record" | "ask" | "handsfree" | "todo" | "calendar";

export type PremiumStatus = Access & {
  /** RevenueCat isn't set up in this build (no public SDK key). */
  unavailable: boolean;
  /** Development builds only: forced on by files/dev-premium.json. */
  devOverride: boolean;
  managementUrl: string | null;
};

export type PlansResult = { kind: "ok"; plans: PlanOption[] } | { kind: "unavailable" | "offline" };

export type PurchaseResult =
  | { kind: "purchased" }
  | { kind: "pending" }
  | { kind: "cancelled" }
  | { kind: "offline" }
  | { kind: "unavailable" }
  | { kind: "failed" };

export type RestoreResult = { kind: "restored" } | { kind: "nothing" } | { kind: "offline" } | { kind: "failed" };

/** Google Play's subscription centre, for when RevenueCat has no URL yet. */
export function playSubscriptionsUrl(packageName: string | undefined): string {
  return packageName
    ? `https://play.google.com/store/account/subscriptions?package=${encodeURIComponent(packageName)}`
    : "https://play.google.com/store/account/subscriptions";
}

const NONE: Access = { premium: false, state: "none", until: null, offline: false, checkedAt: null, expiresAt: null };

let configured = false;
let initPromise: Promise<void> | null = null;
let snapshot: EntitlementSnapshot | null = null;
let devOverride = false;
let status: PremiumStatus = { ...NONE, unavailable: true, devOverride: false, managementUrl: null };
const packagesById = new Map<string, PurchasesPackage>();
const listeners = new Set<(status: PremiumStatus) => void>();

function apiKey(): string {
  const extra = Constants.expoConfig?.extra as { revenueCat?: { androidApiKey?: unknown } } | undefined;
  const key = extra?.revenueCat?.androidApiKey;
  return typeof key === "string" ? key.trim() : "";
}

function packageName(): string | undefined {
  return Constants.expoConfig?.android?.package;
}

async function readDevOverride(): Promise<boolean> {
  if (!isDevelopmentBuild() || !FileSystem.documentDirectory) return false;
  try {
    const raw = await FileSystem.readAsStringAsync(`${FileSystem.documentDirectory}dev-premium.json`);
    return (JSON.parse(raw) as { premium?: unknown }).premium === true;
  } catch {
    return false;
  }
}

async function recompute(): Promise<PremiumStatus> {
  const prefs = await readPreferences();
  const now = Date.now();
  const access = devOverride
    ? { premium: true, state: "active" as const, until: null, offline: false, checkedAt: null, expiresAt: null }
    : decideAccess({ snapshot, now, lastObservedAt: prefs.billingClock.lastObservedAt });
  const clock = nextClock(prefs.billingClock, now, snapshot?.verifiedAt ?? null);
  if (clock.lastObservedAt !== prefs.billingClock.lastObservedAt || clock.lastVerifiedAt !== prefs.billingClock.lastVerifiedAt) {
    await writePreferences({ billingClock: clock });
  }
  status = {
    ...access,
    unavailable: !configured && !devOverride,
    devOverride,
    managementUrl: snapshot?.managementUrl ?? playSubscriptionsUrl(packageName()),
  };
  for (const listener of listeners) listener(status);
  return status;
}

function accept(info: CustomerInfoLike): void {
  const next = snapshotFrom(info);
  // Never step back to an older check than the one already held.
  if (next && (!snapshot || next.verifiedAt >= snapshot.verifiedAt)) snapshot = next;
}

async function refresh(): Promise<PremiumStatus> {
  if (configured) {
    try {
      accept((await Purchases.getCustomerInfo()) as unknown as CustomerInfoLike);
    } catch {
      // Offline with nothing cached, or a RevenueCat outage: keep the last
      // known snapshot — the policy decides what it still allows.
    }
  }
  return recompute();
}

/** Starts RevenueCat (anonymous customer) once per process. Safe to call often. */
export function initPremium(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    devOverride = await readDevOverride();
    const key = apiKey();
    if (key) {
      try {
        await Purchases.setLogLevel(isDevelopmentBuild() ? LOG_LEVEL.INFO : LOG_LEVEL.ERROR);
        Purchases.configure({
          apiKey: key,
          automaticDeviceIdentifierCollectionEnabled: false,
          diagnosticsEnabled: false,
          entitlementVerificationMode: Purchases.ENTITLEMENT_VERIFICATION_MODE.INFORMATIONAL,
        });
        configured = true;
        Purchases.addCustomerInfoUpdateListener((info) => {
          accept(info as unknown as CustomerInfoLike);
          void recompute();
        });
        AppState.addEventListener("change", (state) => {
          if (state === "active") void refresh();
        });
      } catch {
        configured = false;
      }
    }
    await refresh();
  })();
  return initPromise;
}

export function getPremiumStatus(): PremiumStatus {
  return status;
}

export function subscribePremium(listener: (status: PremiumStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshPremium(): Promise<PremiumStatus> {
  await initPremium();
  return refresh();
}

// ---------------------------------------------------------------------------
// The paywall (one, app-wide; PaywallHost renders it)

type PaywallState = { open: boolean; feature: PremiumFeature | null };
let paywall: PaywallState = { open: false, feature: null };
const paywallListeners = new Set<(state: PaywallState) => void>();

export function showPaywall(feature: PremiumFeature | null = null): void {
  paywall = { open: true, feature };
  for (const l of paywallListeners) l(paywall);
}

export function hidePaywall(): void {
  paywall = { open: false, feature: null };
  for (const l of paywallListeners) l(paywall);
}

export function subscribePaywall(listener: (state: PaywallState) => void): () => void {
  paywallListeners.add(listener);
  listener(paywall);
  return () => paywallListeners.delete(listener);
}

/**
 * The gate for premium actions. True when Premium is active; otherwise opens
 * the paywall and returns false — the caller simply doesn't start the
 * action. Waits briefly for the first status on a cold start so a subscriber
 * isn't shown the paywall by mistake.
 */
export async function ensurePremium(feature: PremiumFeature): Promise<boolean> {
  await Promise.race([initPremium(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  const current = await recompute();
  if (current.premium) return true;
  showPaywall(feature);
  return false;
}

// ---------------------------------------------------------------------------
// Plans, purchase, restore

const codeOf = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

export async function loadPlans(): Promise<PlansResult> {
  await initPremium();
  if (!configured) return { kind: "unavailable" };
  try {
    const offerings = await Purchases.getOfferings();
    const packages = offerings.current?.availablePackages ?? [];
    packagesById.clear();
    for (const p of packages) packagesById.set(p.identifier, p);
    const plans = plansFromPackages(packages);
    return plans.length > 0 ? { kind: "ok", plans } : { kind: "unavailable" };
  } catch (err) {
    const code = codeOf(err);
    return code === PURCHASES_ERROR_CODE.NETWORK_ERROR || code === PURCHASES_ERROR_CODE.OFFLINE_CONNECTION_ERROR
      ? { kind: "offline" }
      : { kind: "unavailable" };
  }
}

export async function purchasePlan(packageId: string): Promise<PurchaseResult> {
  const pkg = packagesById.get(packageId);
  if (!configured || !pkg) return { kind: "unavailable" };
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    accept(customerInfo as unknown as CustomerInfoLike);
    const now = await recompute();
    // A purchase Google hasn't been paid for yet grants nothing until it is.
    return now.premium ? { kind: "purchased" } : { kind: "pending" };
  } catch (err) {
    switch (codeOf(err)) {
      case PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR:
        return { kind: "cancelled" };
      case PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR:
        return { kind: "pending" };
      case PURCHASES_ERROR_CODE.NETWORK_ERROR:
      case PURCHASES_ERROR_CODE.OFFLINE_CONNECTION_ERROR:
        return { kind: "offline" };
      case PURCHASES_ERROR_CODE.PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR:
      case PURCHASES_ERROR_CODE.CONFIGURATION_ERROR:
        return { kind: "unavailable" };
      default:
        return { kind: "failed" };
    }
  }
}

export async function restorePurchases(): Promise<RestoreResult> {
  await initPremium();
  if (!configured) return { kind: "failed" };
  try {
    accept((await Purchases.restorePurchases()) as unknown as CustomerInfoLike);
    return (await recompute()).premium ? { kind: "restored" } : { kind: "nothing" };
  } catch (err) {
    const code = codeOf(err);
    return code === PURCHASES_ERROR_CODE.NETWORK_ERROR || code === PURCHASES_ERROR_CODE.OFFLINE_CONNECTION_ERROR
      ? { kind: "offline" }
      : { kind: "failed" };
  }
}

/** Test seam: resets module state between tests. */
export function __resetPremiumForTests(): void {
  configured = false;
  initPromise = null;
  snapshot = null;
  devOverride = false;
  status = { ...NONE, unavailable: true, devOverride: false, managementUrl: null };
  packagesById.clear();
  listeners.clear();
  paywall = { open: false, feature: null };
  paywallListeners.clear();
}
