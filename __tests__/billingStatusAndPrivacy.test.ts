/**
 * Xayra Premium: the Settings status wording, privacy guarantees enforced
 * by scanning the source, and the feature-gate map — premium actions are
 * gated, data management never is.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { premiumStatusText } from "../services/billing/statusText";
import type { PremiumStatus } from "../services/billing/premium";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T10:00:00Z");
const status = (over: Partial<PremiumStatus>): PremiumStatus => ({
  premium: false,
  state: "none",
  until: null,
  offline: false,
  checkedAt: T0,
  expiresAt: null,
  unavailable: false,
  devOverride: false,
  managementUrl: "https://play.google.com/store/account/subscriptions",
  ...over,
});

describe("Settings status wording", () => {
  it.each([
    [{ premium: true, state: "trial", expiresAt: T0 + 30 * DAY }, /^Free trial, ends /],
    [{ premium: true, state: "active", expiresAt: T0 + 30 * DAY }, /^Active, renews /],
    [{ premium: true, state: "cancelled", expiresAt: T0 + 5 * DAY }, /^Cancelled\. Premium continues until /],
    [{ premium: true, state: "billing-issue" }, /problem with your payment/],
    [{ premium: false, state: "expired", expiresAt: T0 - DAY }, /has ended\. Your notes, to-dos and backups stay on your phone and remain yours\./],
    [{ premium: false, state: "none" }, /^You don't have Premium\. Your notes/],
    [{ premium: false, state: "unverified" }, /couldn't be confirmed/],
    [{ premium: false, state: "active", offline: true }, /^Connect to the internet to confirm your subscription\.$/],
    [{ unavailable: true }, /aren't available in this version/],
  ] as [Partial<PremiumStatus>, RegExp][])("%o", (over, expected) => {
    expect(premiumStatusText(status(over))).toMatch(expected);
  });

  it("offline but still within the allowance says when it was last confirmed", () => {
    expect(premiumStatusText(status({ premium: true, state: "active", offline: true, expiresAt: T0 + 30 * DAY }))).toMatch(/Last confirmed /);
  });

  it("a lapsed subscription never says data was removed or locked", () => {
    for (const s of ["expired", "none", "unverified"] as const) {
      expect(premiumStatusText(status({ state: s }))).not.toMatch(/delet|remov|lost|locked/i);
    }
  });
});

const ROOT = join(__dirname, "..");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
const APP_SOURCES = ["app", "components", "services", "hooks", "utils", "constants"].flatMap((d) => sources(d));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("privacy: what RevenueCat can receive", () => {
  it("only services/billing/premium.ts imports the RevenueCat SDK", () => {
    expect(APP_SOURCES.filter((f) => /from "react-native-purchases"/.test(read(f)))).toEqual([join("services", "billing", "premium.ts")]);
  });

  it("no identity, attribute, attribution or device-identifier calls anywhere", () => {
    const forbidden =
      /Purchases\.(logIn|setAttributes|setEmail|setDisplayName|setPhoneNumber|setPushToken|collectDeviceIdentifiers|setAd[A-Za-z]*|setAppsflyerID|setFBAnonymousID|setMparticleID|setOnesignalID|setAirshipChannelID|setCleverTapID|setFirebaseAppInstanceID|setMixpanelDistinctID|setTenjinAnalyticsInstallationID|setKochavaDeviceID|setCreative|setCampaign|setKeyword|setMediaSource|enableAdServicesAttributionTokenCollection)\b/;
    expect(APP_SOURCES.filter((f) => forbidden.test(read(f)))).toEqual([]);
  });

  it("the billing service never touches notes, transcripts, Ask, reminders, calendar or backups", () => {
    const billing = sources(join("services", "billing")).map(read).join("\n");
    expect(billing).not.toMatch(/from "\.\.\/(notes|todos|ai\/(rag|localLlama|localWhisper)|backup|sync|notifications|vault)\//);
  });

  it("the advertising-ID permission is blocked in app.json", () => {
    const app = JSON.parse(read("app.json"));
    expect(app.expo.android.blockedPermissions).toContain("com.google.android.gms.permission.AD_ID");
    expect(app.expo.android.permissions ?? []).not.toContain("com.google.android.gms.permission.AD_ID");
  });

  it("only a public SDK key slot is in the app config — no service-account material in the repo", () => {
    const app = read("app.json");
    expect(JSON.parse(app).expo.extra.revenueCat).toEqual({ androidApiKey: expect.any(String) });
    expect(app).not.toMatch(/private_key|client_email|service_account/);
    // Only RevenueCat's Google Play public key (or none). A Test Store key
    // (test_) crashes release builds on purpose; a secret key (sk_) must never
    // ship.
    expect(JSON.parse(app).expo.extra.revenueCat.androidApiKey).toMatch(/^(goog_[A-Za-z0-9]+)?$/);
  });
});

describe("feature gates", () => {
  const home = read(join("app", "index.tsx"));
  const todos = read(join("components", "TodosOverlay.tsx"));
  const section = (src: string, start: string) => src.slice(src.indexOf(start), src.indexOf(start) + 900);

  it.each([
    ["new voice notes and voice Ask (central tap and launcher shortcuts)", home, "const startManualUtterance = useCallback(", /ensurePremium\(mode === "ask" \? "ask" : "record"\)/],
    ["typed notes and typed Ask", home, "const handleSubmitText = useCallback(", /ensurePremium\(inputMode === "ask" \? "ask" : "record"\)/],
    ["turning Handsfree on", home, "const handleToggleHandsfree = useCallback(", /ensurePremium\("handsfree"\)/],
    ["sending a to-do to Google Calendar", todos, "const handleSendToCalendar = useCallback(", /!wasLinked && !\(await ensurePremium\("calendar"\)\)/],
  ] as [string, string, string, RegExp][])("%s is gated", (_label, src, start, gate) => {
    expect(section(src, start)).toMatch(gate);
  });

  it("adding a new to-do is gated; the add sheet opens only with Premium", () => {
    expect(todos).toMatch(/onPress=\{\(\) => void ensurePremium\("todo"\)\.then\(\(ok\) => ok && setIsAddVisible\(true\)\)\}/);
  });

  it("the gate is used nowhere else: data management, reminders, backup, restore and export stay free", () => {
    const users = APP_SOURCES.filter((f) => /ensurePremium\(/.test(read(f)) && !f.startsWith(join("services", "billing")));
    expect(users.sort()).toEqual([join("app", "index.tsx"), join("components", "TodosOverlay.tsx")].sort());
    expect((home.match(/ensurePremium\(/g) ?? []).length).toBe(3);
    expect((todos.match(/ensurePremium\(/g) ?? []).length).toBe(2);
  });

  it("no data service depends on subscription status", () => {
    const dataServices = ["notes", "todos", "backup", "sync", "vault", "notifications", "export", "recovery"].flatMap((d) => sources(join("services", d)));
    expect(dataServices.filter((f) => /from "[^"]*\/billing\//.test(read(f)))).toEqual([]);
  });
});
