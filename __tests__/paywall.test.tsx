/**
 * The Premium paywall (components/billing/Paywall.tsx): monthly preselected,
 * Google Play's prices and full terms shown before purchase, the trial only
 * when offered, and calm outcomes for pending / unavailable. Synthetic plans.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const mockLoadPlans = jest.fn();
const mockPurchase = jest.fn();
const mockRestore = jest.fn();
const mockHide = jest.fn();
jest.mock("../services/billing/premium", () => ({
  loadPlans: () => mockLoadPlans(),
  purchasePlan: (id: string) => mockPurchase(id),
  restorePurchases: () => mockRestore(),
  hidePaywall: () => mockHide(),
  subscribePaywall: jest.fn(() => () => {}),
}));
jest.mock("../components/Toast", () => ({ showToast: jest.fn() }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));

import { Paywall } from "../components/billing/Paywall";

const plan = (kind: string, title: string, price: string, per: string, trial: string | null) => ({
  kind,
  packageId: `$rc_${kind}`,
  title,
  price,
  per,
  trial,
  terms: trial ? `Free for 1 month, then ${price} ${per}. Renews automatically until you cancel in Google Play.` : `${price} ${per}. Renews automatically until you cancel in Google Play.`,
});
const PLANS = [
  plan("weekly", "Weekly", "AU$3.49", "a week", "1 month free"),
  plan("monthly", "Monthly", "AU$9.99", "a month", "1 month free"),
  plan("six-month", "Every 6 months", "AU$44.99", "every 6 months", "1 month free"),
  plan("yearly", "Yearly", "AU$79.99", "a year", "1 month free"),
];

const texts = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((n) => typeof n.props.children === "string" || Array.isArray(n.props.children))
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : n.props.children))
    .join(" | ");
const pressable = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll((n) => typeof n.props.onPress === "function" && texts({ root: n } as unknown as ReactTestRenderer).includes(label))[0];

async function render(feature: "record" | null = "record") {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<Paywall feature={feature} />);
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadPlans.mockResolvedValue({ kind: "ok", plans: PLANS });
});

it("opens with monthly selected and shows its full renewal terms before purchase", async () => {
  const tree = await render();
  const radios = tree.root.findAll((n) => n.props.accessibilityRole === "radio" && typeof n.type === "string");
  expect(radios.map((r) => [r.props.accessibilityLabel, r.props.accessibilityState.checked])).toEqual([
    ["Weekly, AU$3.49 a week, 1 month free", false],
    ["Monthly, AU$9.99 a month, 1 month free", true],
    ["Every 6 months, AU$44.99 every 6 months, 1 month free", false],
    ["Yearly, AU$79.99 a year, 1 month free", false],
  ]);
  const all = texts(tree);
  expect(all).toContain("Free for 1 month, then AU$9.99 a month. Renews automatically until you cancel in Google Play. Cancel anytime in Google Play.");
  expect(all).toContain("Start free trial");
  expect(all).toContain("Recording new notes is part of Xayra Premium.");
  expect(all).toContain("Your saved notes, to-dos and backups stay yours, with or without Premium.");
});

it("without a trial offer, says Subscribe and never promises a free month", async () => {
  mockLoadPlans.mockResolvedValue({ kind: "ok", plans: [plan("monthly", "Monthly", "AU$9.99", "a month", null)] });
  const tree = await render();
  const all = texts(tree);
  expect(all).toContain("Subscribe");
  expect(all).not.toMatch(/free trial|month free|free for/i);
});

it("buys the selected plan; a pending payment is explained and doesn't close the paywall", async () => {
  mockPurchase.mockResolvedValue({ kind: "pending" });
  const tree = await render();
  await act(async () => {
    pressable(tree, "Start free trial").props.onPress();
  });
  expect(mockPurchase).toHaveBeenCalledWith("$rc_monthly");
  expect(texts(tree)).toContain("Your payment is pending. Premium starts as soon as Google Play confirms it.");
  expect(mockHide).not.toHaveBeenCalled();
});

it("a completed purchase closes the paywall", async () => {
  mockPurchase.mockResolvedValue({ kind: "purchased" });
  const tree = await render();
  await act(async () => {
    pressable(tree, "Start free trial").props.onPress();
  });
  expect(mockHide).toHaveBeenCalled();
});

it("no plans from Play (missing products or outage): says so, offers to try again, can't purchase", async () => {
  mockLoadPlans.mockResolvedValue({ kind: "unavailable" });
  const tree = await render(null);
  expect(texts(tree)).toContain("Plans aren't available right now.");
  const buy = tree.root.findAll((n) => n.props.accessibilityRole === "button" && n.props.disabled === true);
  expect(buy.length).toBeGreaterThan(0);
  expect(mockPurchase).not.toHaveBeenCalled();
});

it("restore with nothing to restore explains it", async () => {
  mockRestore.mockResolvedValue({ kind: "nothing" });
  const tree = await render();
  await act(async () => {
    pressable(tree, "Restore purchases").props.onPress();
  });
  expect(texts(tree)).toContain("No active Premium subscription was found for this Google account.");
});
