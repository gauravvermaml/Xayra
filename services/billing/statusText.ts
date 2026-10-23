/**
 * The subscription line in Settings — pure, so every state's wording is
 * tested. Calm and factual: a lapsed subscription never sounds like lost
 * data, because no data is ever lost.
 */
import type { PremiumStatus } from "./premium";

const DATA_IS_YOURS = "Your notes, to-dos and backups stay on your phone and remain yours.";

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function premiumStatusText(status: PremiumStatus): string {
  if (status.devOverride) return "Premium is on (development build override).";
  if (status.unavailable) return `Subscriptions aren't available in this version. ${DATA_IS_YOURS}`;
  const ends = status.expiresAt !== null ? day(status.expiresAt) : null;
  if (!status.premium) {
    switch (status.state) {
      case "unverified":
        return "Your subscription couldn't be confirmed. Connect to the internet and open Xayra again.";
      case "expired":
        return status.offline && ends === null
          ? "Connect to the internet to confirm your subscription."
          : `Your Premium subscription has ended. ${DATA_IS_YOURS}`;
      case "none":
        return `You don't have Premium. ${DATA_IS_YOURS}`;
      default:
        // Active when last checked, but that check is too old to rely on.
        return "Connect to the internet to confirm your subscription.";
    }
  }
  const offline = status.offline && status.checkedAt !== null ? ` Last confirmed ${day(status.checkedAt)}.` : "";
  switch (status.state) {
    case "trial":
      return `Free trial${ends ? `, ends ${ends}` : ""}.${offline}`;
    case "cancelled":
      return `Cancelled. Premium continues until ${ends ?? "the end of this period"}.${offline}`;
    case "billing-issue":
      return `There's a problem with your payment. Google Play is retrying — check your payment method in Google Play.${offline}`;
    default:
      return `Active${ends ? `, renews ${ends}` : ""}.${offline}`;
  }
}
