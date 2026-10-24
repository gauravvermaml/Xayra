/**
 * The one Xayra Premium paywall. Opened by a premium action (or "See
 * plans" in Settings) through services/billing/premium.ts; PaywallHost is
 * mounted once at the root.
 *
 * Prices, periods and the free trial all come from Google Play (plans.ts);
 * monthly is preselected. The trial line appears only when Play offers this
 * customer a trial. The full renewal terms of the selected plan are shown
 * above the button, before purchase.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MIN_TOUCH_TARGET, xayraColors, xayraRadius } from "../../constants/xayraTheme";
import { defaultPlan, type PlanOption } from "../../services/billing/plans";
import {
  hidePaywall,
  loadPlans,
  purchasePlan,
  restorePurchases,
  subscribePaywall,
  type PremiumFeature,
} from "../../services/billing/premium";
import { showToast } from "../Toast";
import { XText } from "../ui/XText";

export const PRIVACY_POLICY_URL = "https://gist.github.com/gauravvermaml/9cdeb107d9a85a24370e307237450aa3";

const LEAD: Record<PremiumFeature, string> = {
  record: "Recording new notes is part of Xayra Premium.",
  ask: "Asking about your notes is part of Xayra Premium.",
  handsfree: "Handsfree is part of Xayra Premium.",
  todo: "Adding new to-dos is part of Xayra Premium.",
  calendar: "Sending to Google Calendar is part of Xayra Premium.",
};

const BENEFITS = ["Record voice and typed notes", "Ask questions about your notes", "Handsfree", "To-dos, reminders and Google Calendar"];

type Phase = { kind: "loading" } | { kind: "ready"; plans: PlanOption[] } | { kind: "unavailable" } | { kind: "offline" };

export function PaywallHost() {
  const [state, setState] = useState<{ open: boolean; feature: PremiumFeature | null }>({ open: false, feature: null });
  useEffect(() => subscribePaywall(setState), []);
  return state.open ? <Paywall feature={state.feature} /> : null;
}

export function Paywall({ feature }: { feature: PremiumFeature | null }) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"buy" | "restore" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    const result = await loadPlans();
    if (result.kind === "ok") {
      setPhase({ kind: "ready", plans: result.plans });
      setSelected(defaultPlan(result.plans)?.packageId ?? null);
    } else {
      setPhase({ kind: result.kind });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const plans = phase.kind === "ready" ? phase.plans : [];
  const plan = plans.find((p) => p.packageId === selected) ?? null;

  const buy = useCallback(async () => {
    if (!plan || busy) return;
    setBusy("buy");
    setMessage(null);
    const result = await purchasePlan(plan.packageId);
    setBusy(null);
    switch (result.kind) {
      case "purchased":
        hidePaywall();
        showToast("Welcome to Xayra Premium");
        return;
      case "pending":
        setMessage("Your payment is pending. Premium starts as soon as Google Play confirms it.");
        return;
      case "cancelled":
        return;
      case "offline":
        setMessage("You're offline. Connect to the internet and try again.");
        return;
      case "unavailable":
        setMessage("This plan isn't available right now. Please try again later.");
        return;
      default:
        setMessage("The purchase didn't go through. You haven't been charged by Xayra; please try again.");
    }
  }, [plan, busy]);

  const restore = useCallback(async () => {
    if (busy) return;
    setBusy("restore");
    setMessage(null);
    const result = await restorePurchases();
    setBusy(null);
    if (result.kind === "restored") {
      hidePaywall();
      showToast("Premium restored");
    } else if (result.kind === "nothing") {
      setMessage("No active Premium subscription was found for this Google account.");
    } else if (result.kind === "offline") {
      setMessage("You're offline. Connect to the internet and try again.");
    } else {
      setMessage("Purchases couldn't be restored right now. Please try again later.");
    }
  }, [busy]);

  return (
    <Modal visible animationType="slide" onRequestClose={hidePaywall} statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.topRow}>
          <Pressable onPress={hidePaywall} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} style={styles.close}>
            <Feather name="x" size={22} color={xayraColors.textMuted} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <XText variant="wordmark" accessibilityRole="header">
            Xayra Premium
          </XText>
          <XText variant="guidance" style={styles.lead}>
            {feature ? LEAD[feature] : "Record, ask and plan with Xayra."}
          </XText>
          <View style={styles.benefits}>
            {BENEFITS.map((b) => (
              <View key={b} style={styles.benefit}>
                <Feather name="check" size={16} color={xayraColors.lilac} />
                <XText variant="cue" color="textSoft">
                  {b}
                </XText>
              </View>
            ))}
          </View>
          <XText variant="meta" style={styles.reassure}>
            Your saved notes, to-dos and backups stay yours, with or without Premium.
          </XText>

          {phase.kind === "loading" ? <ActivityIndicator color={xayraColors.textMuted} style={styles.loading} /> : null}
          {phase.kind === "unavailable" || phase.kind === "offline" ? (
            <View style={styles.notice}>
              <XText variant="guidance">
                {phase.kind === "offline" ? "Connect to the internet to see plans." : "Plans aren't available right now."}
              </XText>
              <Pressable onPress={() => void load()} accessibilityRole="button" style={styles.retry}>
                <XText variant="chip">Try again</XText>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.plans} accessibilityRole="radiogroup">
            {plans.map((p) => {
              const on = p.packageId === selected;
              return (
                <Pressable
                  key={p.packageId}
                  onPress={() => setSelected(p.packageId)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${p.title}, ${p.price} ${p.per}${p.trial ? `, ${p.trial}` : ""}`}
                  style={[styles.plan, on && styles.planOn]}
                >
                  <View style={styles.planText}>
                    <XText variant="segment">{p.title}</XText>
                    <XText variant="meta">
                      {p.price} {p.per}
                    </XText>
                  </View>
                  {p.trial ? (
                    <View style={styles.badge}>
                      <XText variant="badge">{p.trial}</XText>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        <View style={styles.footer}>
          {message ? (
            <XText variant="meta" color="textSoft" style={styles.message}>
              {message}
            </XText>
          ) : null}
          {plan ? (
            <XText variant="meta" style={styles.terms}>
              {plan.terms} Cancel anytime in Google Play.
            </XText>
          ) : null}
          <Pressable
            onPress={() => void buy()}
            disabled={!plan || busy !== null}
            accessibilityRole="button"
            style={({ pressed }) => [styles.buy, (!plan || busy !== null) && styles.disabled, pressed && styles.pressed]}
          >
            {busy === "buy" ? (
              <ActivityIndicator color={xayraColors.background} />
            ) : (
              <XText variant="segment" style={styles.buyText}>
                {plan?.trial ? "Start free trial" : "Subscribe"}
              </XText>
            )}
          </Pressable>
          <View style={styles.links}>
            <Pressable onPress={() => void restore()} disabled={busy !== null} accessibilityRole="button" hitSlop={8}>
              {busy === "restore" ? <ActivityIndicator color={xayraColors.textMuted} size="small" /> : <XText variant="chip">Restore purchases</XText>}
            </Pressable>
            <Pressable onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)} accessibilityRole="link" hitSlop={8}>
              <XText variant="chip">Privacy policy</XText>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: xayraColors.background, paddingHorizontal: 20 },
  topRow: { flexDirection: "row", justifyContent: "flex-end" },
  close: { width: MIN_TOUCH_TARGET, height: MIN_TOUCH_TARGET, alignItems: "center", justifyContent: "center" },
  content: { paddingBottom: 16 },
  lead: { marginTop: 8 },
  benefits: { marginTop: 18, gap: 10 },
  benefit: { flexDirection: "row", alignItems: "center", gap: 10 },
  reassure: { marginTop: 16 },
  loading: { marginTop: 28 },
  notice: { marginTop: 24, gap: 12, alignItems: "flex-start" },
  retry: { minHeight: MIN_TOUCH_TARGET, justifyContent: "center" },
  plans: { marginTop: 22, gap: 10 },
  plan: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: xayraRadius.card,
    backgroundColor: xayraColors.surface,
    borderWidth: 1.5,
    borderColor: xayraColors.line,
  },
  planOn: { borderColor: xayraColors.lilacRing, backgroundColor: xayraColors.lilacSoft },
  planText: { flex: 1, gap: 2 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: xayraColors.badge },
  footer: { gap: 10, paddingTop: 8 },
  message: { textAlign: "center" },
  terms: { textAlign: "center" },
  buy: {
    minHeight: 52,
    borderRadius: 999,
    backgroundColor: xayraColors.lilac,
    alignItems: "center",
    justifyContent: "center",
  },
  buyText: { color: xayraColors.background },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  links: { flexDirection: "row", justifyContent: "center", gap: 28, minHeight: MIN_TOUCH_TARGET, alignItems: "center" },
});
