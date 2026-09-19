import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getRawDatabase } from "../db/client";
import { colors, spacing, typography } from "../constants/theme";
import { createTextNote, listNotes } from "../services/notes/noteManager";

/**
 * DEV-ONLY note seeder, for evaluating RAG answer quality against a
 * realistic corpus.
 *
 * Reachable at `xayra://dev-seed` (or /dev-seed in the router) and inert
 * unless `__DEV__` — a production build renders the disabled notice and can
 * never write anything. Not part of any navigation flow; nothing links here.
 *
 * WHY A SCREEN AND NOT A SCRIPT. The notes database is SQLCipher-encrypted
 * with a key held in SecureStore behind the biometric gate, so it cannot be
 * written from adb or any host-side tool. Seeding has to run inside the app
 * process. It also has to go through `createTextNote()` rather than raw
 * INSERTs, because that is what generates the embedding each note needs to
 * be retrievable at all — a directly-inserted row is invisible to vector
 * search and would make the corpus useless for exactly the thing it exists
 * to test.
 *
 * Seeding deliberately triggers the normal to-do extraction side effect, so
 * the corpus doubles as date-mechanics coverage. That work is queued at
 * "background" priority and a live query preempts it, so there is no need to
 * wait for extraction to drain before asking questions.
 */

type SeedNote = {
  /** Whole days before today. 0 = today. Backdated after insert so the
   * corpus spans a realistic window — `createTextNote()` always stamps
   * `created_at` as now, and the DATE FILTER law can't be exercised against
   * a corpus where every note shares one timestamp. */
  daysAgo: number;
  text: string;
};

/**
 * Chosen to exercise specific guardrails rather than to look plausible:
 *
 *  - Two notes about Anita (0, 25) that must be combined for "what do I need
 *    for the dinner", while the Eli/Elias note (10) must NOT be blended in.
 *  - A near-name collision (Eli vs Elias) for disambiguation.
 *  - The exact "7 days before the end of September" phrasing whose misparse
 *    was fixed this build — extraction should now land on the 23rd.
 *  - A date range (Queenstown) and several relative/absolute dates.
 *  - Nothing anywhere about passports, insurance or a dentist, so those make
 *    clean zero-hallucination probes.
 */
const SEED_NOTES: SeedNote[] = [
  { daysAgo: 0, text: "Anita's birthday dinner is at Firelight on Saturday, 7pm. Book a table for six." },
  { daysAgo: 1, text: "Car registration expires 30 September. Renew it before then or it lapses." },
  { daysAgo: 2, text: "Dr Patel wants the blood test redone in three weeks, fasting, before 9am." },
  { daysAgo: 4, text: "Mum's flight lands Tuesday the 22nd at 6:40am, terminal 1. Arrange the airport pickup." },
  { daysAgo: 7, text: "Queenstown trip is 14th to 21st November. Book accommodation and ski hire." },
  { daysAgo: 9, text: "Eli recommended the book The Overstory. His brother Elias is moving to Perth in January." },
  { daysAgo: 11, text: "File the tax returns 7 days before the end of September this year." },
  { daysAgo: 14, text: "Pay the strata levy, 1240 dollars, due the first week of October." },
  { daysAgo: 16, text: "Coffee with Marcus about the contract renewal. He wants a decision by mid October." },
  { daysAgo: 20, text: "Replace the kitchen tap washer. Bunnings has the 15mm ones." },
  { daysAgo: 22, text: "Gym membership renews automatically on the 5th of each month. Cancel it if I stop going." },
  { daysAgo: 25, text: "Anita is allergic to shellfish. Remember that for the dinner booking." },
];

const SECONDS_PER_DAY = 86_400;

export default function DevSeedScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  const handleSeed = useCallback(async () => {
    setBusy(true);
    setLog([]);
    try {
      const existing = await listNotes();
      append(`Existing notes before seeding: ${existing.length}`);

      const db = await getRawDatabase();
      const nowSeconds = Math.floor(Date.now() / 1000);

      for (let i = 0; i < SEED_NOTES.length; i++) {
        const { daysAgo, text } = SEED_NOTES[i];
        const note = await createTextNote(text);
        if (daysAgo > 0) {
          await db.execute("UPDATE notes SET created_at = ? WHERE id = ?", [
            nowSeconds - daysAgo * SECONDS_PER_DAY,
            note.id,
          ]);
        }
        append(`${i + 1}/${SEED_NOTES.length}  (-${daysAgo}d)  ${text.slice(0, 46)}…`);
      }

      const after = await listNotes();
      append(`Done. Total notes now: ${after.length}`);
      append("To-do extraction continues in the background; queries preempt it.");
    } catch (err) {
      append(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  if (!__DEV__) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.title}>Unavailable</Text>
        <Text style={styles.body}>The note seeder only runs in development builds.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>Seed test notes</Text>
      <Text style={styles.body}>
        Adds {SEED_NOTES.length} notes spanning the last {SEED_NOTES[SEED_NOTES.length - 1].daysAgo} days, for
        evaluating retrieval and grounding. Safe to run more than once — it adds, it never clears.
      </Text>

      <Pressable
        accessibilityRole="button"
        onPress={handleSeed}
        disabled={busy}
        style={[styles.button, busy && styles.buttonDisabled]}
      >
        <Text style={styles.buttonLabel}>{busy ? "Seeding…" : `Seed ${SEED_NOTES.length} notes`}</Text>
      </Pressable>

      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {log.map((line, i) => (
          <Text key={i} style={styles.logLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.sm },
  body: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.lg },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { ...typography.body, color: colors.background, fontWeight: "600" },
  log: { flex: 1 },
  logContent: { paddingBottom: spacing.xl },
  logLine: { ...typography.caption, color: colors.textSecondary, marginBottom: 4 },
});
