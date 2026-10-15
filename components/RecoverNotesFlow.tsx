import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { colors } from "../constants/theme";
import { AuthenticationFailedError, installRecoveredDatabaseKey, isWellFormedDatabaseKey, RecoveredKeyRefusedError } from "../services/crypto/keyManager";
import {
  cleanupStaleRecoveryStaging,
  probeOriginalVaultWithKey,
  type ProbeResult,
  writeRecoveryPhase,
} from "../services/recovery/originalVaultRecovery";
import { RecoveryCodePrompt } from "./ExtraPrivacyFlows";
import { fetchRecoveryKeyCandidates, restoreExtraPrivacyKeyAfterRecovery, signInForRecovery, switchRecoveryAccount, type DriveUser } from "../services/sync/driveSync";

/**
 * "Recover my notes" (Xayra Dev, Phase 2) — shown from the key-missing
 * screen. Signs in to Google, fetches the backup key into memory, proves it
 * opens a COPY of this phone's vault (services/recovery/originalVaultRecovery.ts),
 * and only after the user confirms, saves it behind the fingerprint. It then
 * hands back to the normal unlock path (`onKeyInstalled`), which is what
 * actually proves the notes open — nothing here claims recovery succeeded.
 *
 * The candidate key lives in a ref only while needed and is dropped on every
 * exit. No note contents or vault details are shown before normal unlock.
 */
type Step =
  | { name: "intro" }
  | { name: "busy"; label: string }
  | { name: "account" }
  | { name: "confirm"; notice?: string }
  | { name: "outcome"; title: string; detail: string; retry?: "check" | "signIn" };

export function outcomeForProbe(result: ProbeResult): { title: string; detail: string } | null {
  switch (result.kind) {
    case "match":
      return null;
    case "doesNotOpen":
      return {
        title: "This backup can't unlock these notes",
        detail: "The key in this account's backup doesn't open the notes on this phone. It may belong to another phone or an earlier install. Nothing was changed.",
      };
    case "corrupt":
      return {
        title: "These notes didn't pass a safety check",
        detail: "The backup key opened a copy of your notes, but the copy failed an integrity check, so it wasn't used. Nothing was changed.",
      };
    case "malformedKey":
      return { title: "The backup key isn't valid", detail: "This account's backup key is damaged. Nothing was changed." };
    case "noVault":
      return { title: "No notes found on this phone", detail: "There's nothing on this phone to unlock. Nothing was changed." };
    case "insufficientStorage":
      return {
        title: "Not enough free space",
        detail: `Checking the key needs a temporary copy of your notes. Free up about ${Math.ceil(
          (result.neededBytes - result.freeBytes) / (1024 * 1024)
        )} MB and try again. Nothing was changed.`,
      };
    case "copyFailed":
      return {
        title: "Couldn't make a safe copy",
        detail: "Xayra couldn't make a complete copy of your notes to test the key, so it stopped. Nothing was changed.",
      };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function RecoverNotesFlow({ onClose, onKeyInstalled }: { onClose: () => void; onKeyInstalled: () => void }) {
  const [step, setStep] = useState<Step>({ name: "intro" });
  const [account, setAccount] = useState<DriveUser | null>(null);
  const candidateKey = useRef<string | null>(null);
  const busy = useRef(false);
  // Extra Privacy: the recovery code, held in memory only while this flow is
  // open — used to open this phone's escrow / protected entries.
  const recoveryCode = useRef<string | null>(null);
  const [codePromptOpen, setCodePromptOpen] = useState(false);

  useEffect(() => () => {
    candidateKey.current = null;
    recoveryCode.current = null;
  }, []);

  const close = useCallback(() => {
    candidateKey.current = null;
    recoveryCode.current = null;
    onClose();
  }, [onClose]);

  /** One step at a time — no overlapping sign-ins, downloads or prompts. */
  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setStep({ name: "busy", label });
    try {
      await action();
    } finally {
      busy.current = false;
    }
  }, []);

  const signIn = useCallback(
    (picker: "remembered" | "switch") =>
      run("Connecting to Google…", async () => {
        try {
          const user =
            picker === "switch"
              ? await switchRecoveryAccount()
              : (await signInForRecovery({ interactive: false })) ?? (await signInForRecovery({ interactive: true }));
          setAccount(user);
          setStep({ name: "account" });
        } catch (err) {
          setStep({ name: "outcome", title: "Couldn't connect to Google", detail: messageOf(err), retry: "signIn" });
        }
      }),
    [run]
  );

  const check = useCallback(
    () =>
      run("Checking your backup…", async () => {
        candidateKey.current = null;
        try {
          await cleanupStaleRecoveryStaging();
          const code = recoveryCode.current;
          const keys = (await fetchRecoveryKeyCandidates(code ? { recoveryCode: code } : {})).filter(isWellFormedDatabaseKey);
          if (keys.length === 0) {
            setStep({
              name: "outcome",
              title: "No backup key in this account",
              detail: "This Google account has no Xayra backup key. Try the account you backed up with. Nothing was changed.",
              retry: "signIn",
            });
            return;
          }
          setStep({ name: "busy", label: "Testing the key on a copy of your notes…" });
          // Each candidate (this phone's entry first) is proven only on a copy;
          // a key that doesn't open it is simply skipped.
          let key: string | null = null;
          let result: ProbeResult = { kind: "doesNotOpen" };
          for (const candidate of keys) {
            result = await probeOriginalVaultWithKey(candidate);
            if (result.kind === "match") {
              key = candidate;
              break;
            }
            if (result.kind !== "doesNotOpen") break;
          }
          const outcome = outcomeForProbe(result);
          if (outcome || !key) {
            setStep({
              name: "outcome",
              ...(outcome ?? outcomeForProbe({ kind: "doesNotOpen" })!),
              retry: result.kind === "insufficientStorage" || result.kind === "copyFailed" ? "check" : undefined,
            });
            return;
          }
          candidateKey.current = key;
          await writeRecoveryPhase("keyValidated");
          setStep({ name: "confirm" });
        } catch (err) {
          setStep({ name: "outcome", title: "Couldn't check the backup", detail: `${messageOf(err)} Nothing was changed.`, retry: "check" });
        }
      }),
    [run]
  );

  const install = useCallback(
    () =>
      run("Confirm with your fingerprint…", async () => {
        const key = candidateKey.current;
        if (!key) {
          setStep({ name: "outcome", title: "Start again", detail: "The checked key is no longer available. Check the backup again.", retry: "check" });
          return;
        }
        try {
          await writeRecoveryPhase("installingKey");
          await installRecoveredDatabaseKey(key);
          await writeRecoveryPhase("keyInstalled");
          candidateKey.current = null;
          // Extra Privacy: the backup key was invalidated with the vault key;
          // put it back behind the fingerprint from this phone's escrow.
          const code = recoveryCode.current;
          recoveryCode.current = null;
          if (code) {
            await restoreExtraPrivacyKeyAfterRecovery(code).catch(() => false);
          }
          onKeyInstalled();
        } catch (err) {
          if (err instanceof AuthenticationFailedError) {
            // Nothing was saved; wait for the user rather than prompting again.
            setStep({ name: "confirm", notice: "Fingerprint wasn't confirmed, so nothing was saved." });
          } else if (err instanceof RecoveredKeyRefusedError && err.reason === "keyAlreadyStored") {
            candidateKey.current = null;
            setStep({
              name: "outcome",
              title: "A key is already on this phone",
              detail: "Close this and unlock Xayra normally. Nothing was changed.",
            });
          } else {
            setStep({ name: "confirm", notice: `Couldn't save the key: ${messageOf(err)} Nothing else was changed.` });
          }
        }
      }),
    [run, onKeyInstalled]
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Recover my notes
      </Text>

      {step.name === "intro" ? (
        <>
          <Text style={styles.body}>
            If you backed up to Google Drive from this phone, the key in that backup may unlock the notes already here —
            including ones added since the backup. Nothing on this phone changes unless you confirm.
          </Text>
          <Button label="Continue with Google" onPress={() => void signIn("remembered")} />
          <Button label="Use my recovery code" secondary onPress={() => setCodePromptOpen(true)} />
          <Button label="Not now" secondary onPress={close} />
        </>
      ) : null}

      {step.name === "busy" ? (
        <View style={styles.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.body}>{step.label}</Text>
        </View>
      ) : null}

      {step.name === "account" && account ? (
        <>
          <Text style={styles.body}>Signed in as {account.email}</Text>
          <Button label="Check this account's backup" onPress={() => void check()} />
          <Button label="Use a different account" secondary onPress={() => void signIn("switch")} />
          <Button label="Cancel" secondary onPress={close} />
        </>
      ) : null}

      {step.name === "confirm" ? (
        <>
          <Text style={styles.heading}>Your notes can be unlocked</Text>
          <Text style={styles.body}>
            The backup key opens the notes on this phone. Unlocking saves this key on this phone, protected by your
            fingerprint. Your notes stay exactly as they are.
          </Text>
          {step.notice ? <Text style={styles.notice}>{step.notice}</Text> : null}
          <Button label="Unlock my notes" onPress={() => void install()} />
          <Button label="Cancel" secondary onPress={close} />
        </>
      ) : null}

      <RecoveryCodePrompt
        visible={codePromptOpen}
        title="Enter your recovery code"
        detail="If you turned on Extra Privacy, your recovery code can unlock the notes on this phone — even offline."
        busy={false}
        error={null}
        onSubmit={(code) => {
          recoveryCode.current = code;
          setCodePromptOpen(false);
          void check();
        }}
        onCancel={() => setCodePromptOpen(false)}
      />

      {step.name === "outcome" ? (
        <>
          <Text style={styles.heading}>{step.title}</Text>
          <Text style={styles.body}>{step.detail}</Text>
          {step.retry === "check" ? <Button label="Try again" onPress={() => void check()} /> : null}
          {step.retry === "signIn" ? <Button label="Use a different account" onPress={() => void signIn("switch")} /> : null}
          <Button label="Close" secondary onPress={close} />
        </>
      ) : null}
    </View>
  );
}

function Button({ label, onPress, secondary = false }: { label: string; onPress: () => void; secondary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, pressed && styles.pressed]}
    >
      <Text style={[styles.buttonLabel, secondary && styles.buttonLabelSecondary]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#0E0F12",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 14,
  },
  title: { color: "#F8FAFC", fontSize: 24, fontWeight: "700", textAlign: "center", marginBottom: 6 },
  heading: { color: "#F8FAFC", fontSize: 17, fontWeight: "600", textAlign: "center" },
  body: { color: "#94A3B8", fontSize: 14, lineHeight: 20, textAlign: "center" },
  notice: { color: "#FCA5A5", fontSize: 14, lineHeight: 20, textAlign: "center" },
  busy: { alignItems: "center", gap: 12 },
  button: {
    minHeight: 48,
    borderRadius: 24,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  buttonSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#334155" },
  pressed: { opacity: 0.7 },
  buttonLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  buttonLabelSecondary: { color: "#CBD5E1", fontWeight: "600" },
});
