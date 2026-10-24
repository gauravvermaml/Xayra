/**
 * services/billing/premium.ts against a mocked RevenueCat SDK: anonymous
 * setup, purchase / pending / cancel, restore, outages, offline, refunds,
 * reinstall, missing products, the gate and the dev override. Synthetic
 * data only.
 */
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const mockState: {
  key: string;
  dev: boolean;
  devFile: string | null;
  prefs: { billingClock: { lastObservedAt: number | null; lastVerifiedAt: number | null } };
} = { key: "goog_public_test_key", dev: false, devFile: null, prefs: { billingClock: { lastObservedAt: null, lastVerifiedAt: null } } };

const mockPurchases = {
  configure: jest.fn(),
  setLogLevel: jest.fn(async () => undefined),
  addCustomerInfoUpdateListener: jest.fn(),
  getCustomerInfo: jest.fn(),
  getOfferings: jest.fn(),
  purchasePackage: jest.fn(),
  restorePurchases: jest.fn(),
  logIn: jest.fn(),
  setAttributes: jest.fn(),
  collectDeviceIdentifiers: jest.fn(),
  ENTITLEMENT_VERIFICATION_MODE: { DISABLED: "DISABLED", INFORMATIONAL: "INFORMATIONAL" },
};

jest.mock("react-native-purchases", () => ({
  __esModule: true,
  default: mockPurchases,
  LOG_LEVEL: { INFO: "INFO", ERROR: "ERROR" },
  PURCHASES_ERROR_CODE: {
    PURCHASE_CANCELLED_ERROR: "1",
    PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR: "5",
    NETWORK_ERROR: "10",
    PAYMENT_PENDING_ERROR: "20",
    CONFIGURATION_ERROR: "23",
    OFFLINE_CONNECTION_ERROR: "35",
  },
}));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { android: { package: "com.anonymous.silentconfidant" }, extra: { revenueCat: { androidApiKey: mockState.key } } };
    },
  },
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  readAsStringAsync: jest.fn(async () => {
    if (mockState.devFile === null) throw new Error("no file");
    return mockState.devFile;
  }),
}));
jest.mock("react-native", () => ({ AppState: { addEventListener: jest.fn() } }));
jest.mock("../services/ai/perf", () => ({ isDevelopmentBuild: () => mockState.dev }));
jest.mock("../services/settings/preferences", () => ({
  readPreferences: jest.fn(async () => mockState.prefs),
  writePreferences: jest.fn(async (patch: object) => {
    mockState.prefs = { ...mockState.prefs, ...patch };
    return mockState.prefs;
  }),
}));

const ent = (over: object = {}) => ({
  isActive: true,
  willRenew: true,
  periodType: "NORMAL",
  expirationDate: iso(T0 + 30 * DAY),
  billingIssueDetectedAt: null,
  ...over,
});
const customer = (e: object | null, at = T0) => ({
  requestDate: iso(at),
  managementURL: "https://play.google.com/store/account/subscriptions?sku=x",
  entitlements: { active: e && (e as { isActive: boolean }).isActive ? { premium: e } : {}, all: e ? { premium: e } : {} },
});
const err = (code: string) => Object.assign(new Error("x"), { code });
const monthlyPackage = {
  identifier: "$rc_monthly",
  packageType: "MONTHLY",
  product: {
    priceString: "Free",
    subscriptionPeriod: "P1M",
    defaultOption: {
      freePhase: { billingPeriod: { unit: "MONTH", value: 1 }, price: { formatted: "Free" } },
      fullPricePhase: { billingPeriod: { unit: "MONTH", value: 1 }, price: { formatted: "AU$9.99" } },
    },
  },
};

let premium: typeof import("../services/billing/premium");

beforeEach(() => {
  jest.useFakeTimers({ now: T0, doNotFake: ["nextTick", "setImmediate"] });
  jest.clearAllMocks();
  Object.assign(mockState, { key: "goog_public_test_key", dev: false, devFile: null, prefs: { billingClock: { lastObservedAt: null, lastVerifiedAt: null } } });
  mockPurchases.getCustomerInfo.mockResolvedValue(customer(null));
  mockPurchases.getOfferings.mockResolvedValue({ current: { availablePackages: [monthlyPackage] } });
  jest.isolateModules(() => {
    premium = require("../services/billing/premium");
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("setup and privacy", () => {
  it("configures an anonymous customer with identifier collection and diagnostics off, and signed-response checks on", async () => {
    await premium.initPremium();
    expect(mockPurchases.configure).toHaveBeenCalledWith({
      apiKey: "goog_public_test_key",
      automaticDeviceIdentifierCollectionEnabled: false,
      diagnosticsEnabled: false,
      entitlementVerificationMode: "INFORMATIONAL",
    });
    expect(mockPurchases.configure.mock.calls[0][0]).not.toHaveProperty("appUserID");
    expect(mockPurchases.logIn).not.toHaveBeenCalled();
    expect(mockPurchases.setAttributes).not.toHaveBeenCalled();
    expect(mockPurchases.collectDeviceIdentifiers).not.toHaveBeenCalled();
  });

  it("no public key in this build: RevenueCat isn't started; premium actions open the paywall; nothing else is affected", async () => {
    mockState.key = "";
    await premium.initPremium();
    expect(mockPurchases.configure).not.toHaveBeenCalled();
    expect(premium.getPremiumStatus()).toMatchObject({ premium: false, unavailable: true });
    const opened: unknown[] = [];
    premium.subscribePaywall((s) => opened.push(s));
    expect(await premium.ensurePremium("record")).toBe(false);
    expect(opened.at(-1)).toEqual({ open: true, feature: "record" });
    expect(await premium.loadPlans()).toEqual({ kind: "unavailable" });
  });
});

describe("status", () => {
  it("trial activation: an active trial entitlement grants premium", async () => {
    mockPurchases.getCustomerInfo.mockResolvedValue(customer(ent({ periodType: "TRIAL" })));
    await premium.initPremium();
    expect(premium.getPremiumStatus()).toMatchObject({ premium: true, state: "trial" });
    expect(await premium.ensurePremium("ask")).toBe(true);
  });

  it("RevenueCat outage after a good check: the cached status keeps working (offline allowance)", async () => {
    mockPurchases.getCustomerInfo.mockResolvedValueOnce(customer(ent())).mockRejectedValue(err("10"));
    await premium.initPremium();
    jest.setSystemTime(T0 + 3 * DAY);
    expect(await premium.refreshPremium()).toMatchObject({ premium: true, offline: true });
    jest.setSystemTime(T0 + 8 * DAY);
    expect(await premium.refreshPremium()).toMatchObject({ premium: false });
  });

  it("the SDK's own cache on a cold start offline (old requestDate) is honoured for up to seven days", async () => {
    mockPurchases.getCustomerInfo.mockResolvedValue(customer(ent(), T0 - 2 * DAY));
    await premium.initPremium();
    expect(premium.getPremiumStatus()).toMatchObject({ premium: true, offline: true });
  });

  it("reinstall while offline (no cache at all): no premium until the first check", async () => {
    mockPurchases.getCustomerInfo.mockRejectedValue(err("35"));
    await premium.initPremium();
    expect(premium.getPremiumStatus()).toMatchObject({ premium: false, state: "none" });
  });

  it("a refund or revocation removes the entitlement at the next check", async () => {
    mockPurchases.getCustomerInfo.mockResolvedValueOnce(customer(ent())).mockResolvedValueOnce(customer(ent({ isActive: false }), T0 + DAY));
    await premium.initPremium();
    jest.setSystemTime(T0 + DAY);
    expect(await premium.refreshPremium()).toMatchObject({ premium: false, state: "expired" });
  });

  it("an older cached response never replaces a newer check", async () => {
    mockPurchases.getCustomerInfo.mockResolvedValueOnce(customer(ent({ isActive: false }), T0)).mockResolvedValueOnce(customer(ent(), T0 - DAY));
    await premium.initPremium();
    expect((await premium.refreshPremium()).premium).toBe(false);
  });
});

describe("purchase and restore", () => {
  beforeEach(async () => {
    await premium.initPremium();
    await premium.loadPlans();
  });

  it("plans come from the offering (monthly, with the trial)", async () => {
    const plans = await premium.loadPlans();
    expect(plans).toMatchObject({ kind: "ok", plans: [{ kind: "monthly", price: "AU$9.99", trial: "1 month free" }] });
  });

  it("successful purchase → premium", async () => {
    mockPurchases.purchasePackage.mockResolvedValue({ customerInfo: customer(ent({ periodType: "TRIAL" })) });
    expect(await premium.purchasePlan("$rc_monthly")).toEqual({ kind: "purchased" });
    expect(premium.getPremiumStatus().premium).toBe(true);
  });

  it("pending purchase (no entitlement yet, or the pending error) → not premium, reported as pending", async () => {
    mockPurchases.purchasePackage.mockResolvedValueOnce({ customerInfo: customer(null) });
    expect(await premium.purchasePlan("$rc_monthly")).toEqual({ kind: "pending" });
    mockPurchases.purchasePackage.mockRejectedValueOnce(err("20"));
    expect(await premium.purchasePlan("$rc_monthly")).toEqual({ kind: "pending" });
    expect(premium.getPremiumStatus().premium).toBe(false);
  });

  it("cancelled, offline, unavailable and unknown failures map to calm results", async () => {
    for (const [code, kind] of [["1", "cancelled"], ["10", "offline"], ["5", "unavailable"], ["999", "failed"]]) {
      mockPurchases.purchasePackage.mockRejectedValueOnce(err(code));
      expect(await premium.purchasePlan("$rc_monthly")).toEqual({ kind });
    }
  });

  it("a plan that isn't in the loaded offering can't be bought", async () => {
    expect(await premium.purchasePlan("$rc_lifetime")).toEqual({ kind: "unavailable" });
  });

  it("restore: active → restored; none → nothing; offline → offline", async () => {
    mockPurchases.restorePurchases.mockResolvedValueOnce(customer(ent()));
    expect(await premium.restorePurchases()).toEqual({ kind: "restored" });
    mockPurchases.restorePurchases.mockResolvedValueOnce(customer(null, T0 + 1));
    expect(await premium.restorePurchases()).toEqual({ kind: "nothing" });
    mockPurchases.restorePurchases.mockRejectedValueOnce(err("35"));
    expect(await premium.restorePurchases()).toEqual({ kind: "offline" });
  });

  it("missing Play products / offering outage → the paywall says plans aren't available", async () => {
    mockPurchases.getOfferings.mockResolvedValueOnce({ current: null });
    expect(await premium.loadPlans()).toEqual({ kind: "unavailable" });
    mockPurchases.getOfferings.mockRejectedValueOnce(err("10"));
    expect(await premium.loadPlans()).toEqual({ kind: "offline" });
  });
});

describe("development override", () => {
  it("only development builds read files/dev-premium.json", async () => {
    mockState.devFile = JSON.stringify({ premium: true });
    mockState.dev = false;
    await premium.initPremium();
    expect(premium.getPremiumStatus()).toMatchObject({ premium: false, devOverride: false });
  });

  it("a development build with the file is premium (for testing without real purchases)", async () => {
    mockState.devFile = JSON.stringify({ premium: true });
    mockState.dev = true;
    await premium.initPremium();
    expect(premium.getPremiumStatus()).toMatchObject({ premium: true, devOverride: true });
  });
});
