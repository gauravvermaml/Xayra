import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";

import { colors } from "../constants/theme";
import {
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
  pickConfirmationGroups,
  recoveryCodeGroups,
} from "../services/backup/recoveryCode";
import { ProtectionChangeUnfinishedError, replaceExtraPrivacyCode, turnOnExtraPrivacy } from "../services/sync/driveSync";
import { userFacingMessage } from "../services/errors/userMessage";
import { restoreTitle } from "../services/sync/restoreSummary";

/**
 * Extra Privacy — "Quiet Intelligence" flows.
 *
 * The recovery code lives only in this component's state while the flow is
 * on screen (cleared on close); it's never logged, stored or uploaded. Xayra
 * generates it — users never invent one — and success is shown only after the
 * code-protected backup was created and independently verified.
 */

type SetupMode = "activate" | "replace";
type Step =
  | { name: "explain" }
  | { name: "code" }
  | { name: "safety" }
  | { name: "confirm" }
  | { name: "working" }
  | { name: "done" }
  | { name: "failed"; message: string }
  | { name: "unfinished"; message: string };

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"];

export function ExtraPrivacySetup({ visible, mode, onClose }: { visible: boolean; mode: SetupMode; onClose: (changed: boolean) => void }) {
  const firstStep = (): Step => (mode === "activate" ? { name: "explain" } : { name: "code" });
  const [step, setStep] = useState<Step>(firstStep);
  const [code, setCode] = useState<string | null>(null);
  const [groups, setGroups] = useState<[number, number]>([1, 4]);
  const [entries, setEntries] = useState<[string, string]>(["", ""]);
  const [understood, setUnderstood] = useState(false);
  const [oldCodeRemoved, setOldCodeRemoved] = useState(true);
  const changed = useRef(false);

  useEffect(() => {
    if (!visible) return;
    changed.current = false;
    setStep(mode === "activate" ? { name: "explain" } : { name: "code" });
    setEntries(["", ""]);
    setUnderstood(false);
    void generateRecoveryCode().then(setCode);
    void pickConfirmationGroups().then(setGroups);
    return () => setCode(null);
  }, [visible, mode]);

  const close = useCallback(() => {
    setCode(null);
    onClose(changed.current);
  }, [onClose]);

  const codeGroups = code ? recoveryCodeGroups(code) : [];
  const normalized = (s: string) => s.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  const confirmOk =
    understood && codeGroups.length === 7 && normalized(entries[0]) === codeGroups[groups[0]] && normalized(entries[1]) === codeGroups[groups[1]];

  const activate = useCallback(async () => {
    if (!code) return;
    setStep({ name: "working" });
    try {
      if (mode === "activate") {
        await turnOnExtraPrivacy(code);
        setOldCodeRemoved(true);
      } else {
        setOldCodeRemoved((await replaceExtraPrivacyCode(code)).oldCodeRemoved);
      }
      changed.current = true;
      setStep({ name: "done" });
    } catch (err) {
      if (err instanceof ProtectionChangeUnfinishedError) {
        changed.current = true;
        setStep({ name: "unfinished", message: err.message });
        return;
      }
      setStep({ name: "failed", message: userFacingMessage(err, "Something went wrong.") });
    }
  }, [code, mode]);

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={step.name === "working" ? () => undefined : close}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        {step.name === "explain" ? (
          <>
            <Text style={styles.title}>Extra Privacy</Text>
            <Text style={styles.body}>Stronger protection for your Google Drive backup.</Text>
            <Bullet text="Your new backups are locked with a recovery code that only you keep. Someone who gets into your Google account can't open them without it." />
            <Bullet text="Nothing changes day to day: your fingerprint still opens Xayra." />
            <Bullet text="You'll need the recovery code to restore your backup on a new phone, or after a change that locks this phone's key." />
            <Button label="Continue" onPress={() => setStep({ name: "code" })} />
            <Button label="Not now" secondary onPress={close} />
          </>
        ) : null}

        {step.name === "code" ? (
          <>
            <Text style={styles.title}>{mode === "activate" ? "Your recovery code" : "Your new recovery code"}</Text>
            <Text style={styles.body}>Xayra created this code for you. Save it somewhere safe now — it won't be shown again.</Text>
            {mode === "replace" ? (
              <Text style={styles.body}>
                Once the new code is active, your old code stops opening your Google Drive backup. Other phones with Xayra
                keep their own protected recovery copy, which the old code can still open until each phone is given the new
                code.
              </Text>
            ) : null}
            {code ? (
              <View style={styles.codeBox} accessible accessibilityLabel={`Recovery code ${codeGroups.join(", ")}`}>
                {codeGroups.map((g, i) => (
                  <Text key={i} style={styles.codeGroup}>
                    {g}
                  </Text>
                ))}
              </View>
            ) : (
              <ActivityIndicator color={colors.accent} />
            )}
            <View style={styles.row}>
              <Button
                label="Copy"
                secondary
                compact
                onPress={() => code && void Clipboard.setStringAsync(formatRecoveryCode(code))}
              />
              <Button
                label="Save to…"
                secondary
                compact
                onPress={() => code && void Share.share({ message: `Xayra recovery code: ${formatRecoveryCode(code)}` }).catch(() => undefined)}
              />
            </View>
            <Text style={styles.caution}>
              Other apps can read what you copy. Paste it into your password manager straight away, then copy something
              else.
            </Text>
            <Button label="Next" onPress={() => setStep({ name: "safety" })} />
            <Button label="Cancel" secondary onPress={close} />
          </>
        ) : null}

        {step.name === "safety" ? (
          <>
            <Text style={styles.title}>Recovery safety check</Text>
            <Text style={styles.body}>Two independent copies are strongly recommended:</Text>
            <Bullet text="A password manager that isn't tied to your Google account." />
            <Bullet text="A paper copy kept somewhere safe at home." />
            <Text style={styles.body}>
              Keeping the code only in the same Google account — Gmail, Google Drive, Keep or Google Photos — weakens the
              extra protection: anyone who gets into that account could find both the backup and the code.
            </Text>
            <Text style={styles.caption}>Xayra can't see or check where you saved it.</Text>
            <Button label="I've saved my code" onPress={() => setStep({ name: "confirm" })} />
            <Button label="Show the code again" secondary onPress={() => setStep({ name: "code" })} />
          </>
        ) : null}

        {step.name === "confirm" ? (
          <>
            <Text style={styles.title}>Confirm your code</Text>
            <Text style={styles.body}>Type two groups from your saved copy.</Text>
            {[0, 1].map((i) => (
              <View key={i} style={styles.field}>
                <Text style={styles.fieldLabel}>{`${ORDINALS[groups[i]].replace(/^./, (c) => c.toUpperCase())} group`}</Text>
                <TextInput
                  style={styles.input}
                  value={entries[i]}
                  onChangeText={(t) => setEntries((prev) => (i === 0 ? [t, prev[1]] : [prev[0], t]))}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  importantForAutofill="no"
                  maxLength={4}
                  placeholder="XXXX"
                  placeholderTextColor="#475569"
                />
              </View>
            ))}
            <Pressable style={styles.check} onPress={() => setUnderstood((u) => !u)} accessibilityRole="checkbox" accessibilityState={{ checked: understood }}>
              <Text style={styles.checkBox}>{understood ? "☑" : "☐"}</Text>
              <Text style={styles.checkText}>
                I understand that if I lose both this code and access to a phone where Xayra opens, my backup can't be
                restored — not by me, and not by Xayra.
              </Text>
            </Pressable>
            <Button label={mode === "activate" ? "Turn on Extra Privacy" : "Use the new code"} onPress={() => confirmOk && void activate()} disabled={!confirmOk} />
            <Button label="Back" secondary onPress={() => setStep({ name: "safety" })} />
          </>
        ) : null}

        {step.name === "working" ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={styles.title}>{mode === "activate" ? "Protecting your backup…" : "Switching to your new code…"}</Text>
            <Text style={styles.body}>
              {mode === "activate"
                ? "Creating a backup locked with your code and checking it can be restored. Keep Xayra open."
                : "Locking your backup key with the new code and checking it. Keep Xayra open."}
            </Text>
          </View>
        ) : null}

        {step.name === "done" ? (
          <>
            <Text style={styles.title}>{mode === "activate" ? "Extra Privacy is on" : "New code is active"}</Text>
            {mode === "activate" ? (
              <>
                <Text style={styles.body}>Your newest backup is locked with your recovery code, and it was checked after uploading.</Text>
                <Text style={styles.body}>
                  Backups made before today are unchanged and can still be opened with Google account access alone. You can
                  remove them in Settings when you're ready. Removing them can't recall copies already downloaded elsewhere.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.body}>
                  {oldCodeRemoved
                    ? "Your Google Drive backup now opens only with the new code."
                    : "Your Google Drive backup now opens with the new code. The old code stops opening it after your next backup."}
                </Text>
                <Text style={styles.body}>
                  If Xayra is set up on another phone, that phone keeps its own protected recovery copy, which the old code can
                  still open until that phone is given the new code. Keep the old code private.
                </Text>
              </>
            )}
            <Button label="Done" onPress={close} />
          </>
        ) : null}

        {step.name === "unfinished" ? (
          <>
            <Text style={styles.title}>Extra Privacy is on</Text>
            <Text style={styles.body}>{step.message}</Text>
            <Button label="Done" onPress={close} />
          </>
        ) : null}

        {step.name === "failed" ? (
          <>
            <Text style={styles.title}>{mode === "activate" ? "Extra Privacy isn't on" : "Your code wasn't changed"}</Text>
            <Text style={styles.body}>{step.message}</Text>
            <Text style={styles.body}>
              {mode === "activate"
                ? "Your backups stay protected the way they were (Standard Protection). Nothing was deleted."
                : "Your current code still works. Nothing was deleted."}
            </Text>
            <Button label="Try again" onPress={() => void activate()} />
            <Button label="Close" secondary onPress={close} />
          </>
        ) : null}
      </ScrollView>
    </Modal>
  );
}

/** Asks for a recovery code; resolves via `onSubmit` with the normalised code
 * only after the typo check passes. */
/** A restore's outcome stays on screen until dismissed (a toast was easy to
 * miss for a result this important). Settings and Archive both use it. */
export function showRestoreResult(result: { restoredCount: number; restoredToDoCount: number; updatedCount?: number; keptCount?: number; message: string }): void {
  Alert.alert(restoreTitle(result), result.message);
}

export function RecoveryCodePrompt({
  visible,
  title,
  detail,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  detail: string;
  busy: boolean;
  error: string | null;
  onSubmit: (code: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [typo, setTypo] = useState(false);
  useEffect(() => {
    if (!visible) {
      setText("");
      setTypo(false);
    }
  }, [visible]);
  const submit = useCallback(async () => {
    const code = await parseRecoveryCode(text);
    if (!code) {
      setTypo(true);
      return;
    }
    setTypo(false);
    onSubmit(code);
  }, [text, onSubmit]);
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={busy ? () => undefined : onCancel}>
      <View style={styles.dim}>
        <View style={styles.sheet}>
          <Text style={styles.heading}>{title}</Text>
          <Text style={styles.body}>{detail}</Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            value={text}
            onChangeText={setText}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            placeholderTextColor="#475569"
            editable={!busy}
          />
          {typo ? <Text style={styles.error}>That doesn't look like a complete recovery code. Check for a typo.</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {busy ? <ActivityIndicator color={colors.accent} /> : <Button label="Continue" onPress={() => void submit()} />}
          {!busy ? <Button label="Cancel" secondary onPress={onCancel} /> : null}
        </View>
      </View>
    </Modal>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  secondary = false,
  compact = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        compact && styles.buttonCompact,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonLabel, secondary && styles.buttonLabelSecondary]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, backgroundColor: "#0E0F12", justifyContent: "center", paddingHorizontal: 28, paddingVertical: 40, gap: 14 },
  center: { alignItems: "center", gap: 14 },
  title: { color: "#F8FAFC", fontSize: 24, fontWeight: "700", textAlign: "center" },
  heading: { color: "#F8FAFC", fontSize: 18, fontWeight: "600", textAlign: "center" },
  body: { color: "#94A3B8", fontSize: 15, lineHeight: 22, textAlign: "center" },
  caption: { color: "#64748B", fontSize: 13, textAlign: "center" },
  caution: { color: "#FBBF24", fontSize: 13, lineHeight: 19, textAlign: "center" },
  error: { color: "#FCA5A5", fontSize: 14, lineHeight: 20, textAlign: "center" },
  codeBox: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10, paddingVertical: 16, paddingHorizontal: 8, borderRadius: 16, backgroundColor: "#151922" },
  codeGroup: { color: "#E2E8F0", fontSize: 22, fontFamily: "monospace", letterSpacing: 2 },
  row: { flexDirection: "row", gap: 12, justifyContent: "center" },
  bullet: { flexDirection: "row", gap: 10, paddingHorizontal: 4 },
  bulletDot: { color: colors.accent, fontSize: 16, lineHeight: 22 },
  bulletText: { flex: 1, color: "#CBD5E1", fontSize: 15, lineHeight: 22 },
  field: { gap: 6 },
  fieldLabel: { color: "#CBD5E1", fontSize: 14 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: "#334155", color: "#F8FAFC", fontSize: 18, fontFamily: "monospace", paddingHorizontal: 14, letterSpacing: 2 },
  codeInput: { fontSize: 15, letterSpacing: 1 },
  check: { flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: 6 },
  checkBox: { color: colors.accent, fontSize: 20 },
  checkText: { flex: 1, color: "#CBD5E1", fontSize: 14, lineHeight: 20 },
  button: { minHeight: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  buttonSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#334155" },
  buttonCompact: { flex: 1 },
  buttonDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  buttonLabel: { color: colors.onAccent, fontSize: 16, fontWeight: "700" },
  buttonLabelSecondary: { color: "#CBD5E1", fontWeight: "600" },
  dim: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", paddingHorizontal: 20 },
  sheet: { backgroundColor: "#0E0F12", borderRadius: 20, padding: 22, gap: 14, borderWidth: 1, borderColor: "#1E293B" },
});
