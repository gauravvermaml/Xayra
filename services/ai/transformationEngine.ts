import * as chrono from "chrono-node";
import { getThermalStatus, ThermalStatus } from "expo-device-cpu";

import {
  buildPrompt,
  detectDatePhrases,
  extractionPrefix,
  normalizeExtracted,
  parseExtractionOutput,
  preFilterZeroTaskNotes,
  TODO_EXTRACTION_GRAMMAR,
  todayIso,
  type ExtractedToDo,
} from "./extractionLogic";

// Re-exported so existing importers (tests, callers) keep their paths while
// the implementations live in the native-free module.
export {
  detectDatePhrases,
  normalizeExtracted,
  preFilterZeroTaskNotes,
  resolveDateAndTime,
  TODO_EXTRACTION_GRAMMAR,
  type ExtractedToDo,
} from "./extractionLogic";
import {
  CHAT_TEMPLATE_STOP_TOKENS,
  runQueuedLlamaCompletion,
  type PromptPrefix,
} from "./localLlama";
import { isTranscriptionInProgress } from "./localWhisper";
import { logDuration, nowMs } from "./perf";

/** Delays tried, in order, while the device reports itself at or above
 * `ThermalStatus.MODERATE` before firing an extraction anyway — extraction
 * has no one waiting on it (unlike a live "Ask" answer), so it's exactly the
 * kind of "can tolerate being delayed" background work that should back off
 * rather than pile more sustained heavy CPU load onto an already-hot
 * chipset. Deliberately gives up and proceeds after these are exhausted,
 * never silently drops a note's extraction forever just because the device
 * stays warm — general device hygiene for any device class, not tuned to
 * any one phone's thermal curve (see [[ram-tier-bad-proxy-for-cpu]] in
 * project memory for why device-specific tuning here would be the wrong
 * instinct). */
const THERMAL_RECHECK_DELAYS_MS = [5000, 15000, 30000];

async function waitForCoolerThermalStateIfNeeded(): Promise<void> {
  for (const delayMs of THERMAL_RECHECK_DELAYS_MS) {
    const status = getThermalStatus();
    // null (pre-Android-10, or the call failing) is treated as "proceed" —
    // this is a nice-to-have deferral, never a dependency the extraction
    // pipeline can be blocked on indefinitely by an unknown signal.
    if (status === null || status < ThermalStatus.MODERATE) {
      if (status !== null) {
        console.log(`[ThermalGate] status=${status} (below MODERATE) — proceeding with extraction.`);
      }
      return;
    }
    console.log(`[ThermalGate] status=${status} (MODERATE+) — deferring extraction ${delayMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.log("[ThermalGate] still warm after all retries — proceeding with extraction anyway.");
}

/** Delays tried while a transcription is in progress, before firing
 * extraction anyway — same shape as `waitForCoolerThermalStateIfNeeded`
 * above, deliberately shorter: a transcription is a one-off few-second job,
 * not a sustained thermal condition, so it's worth only a brief wait rather
 * than the thermal gate's much longer backoff. Whisper (transcription) and
 * Llama (this extraction) are two separate native engines with no shared
 * queue of their own — unlike two Llama completions, which already
 * serialize through localLlama.ts's own priority queue — so without this,
 * a note's own transcription and a PREVIOUS note's to-do extraction can run
 * at the exact same moment and split the CPU between them, visibly slowing
 * down the transcription the user is actively watching a spinner for
 * (confirmed via a tester's on-device report: a second voice note
 * transcribed noticeably slower than the first while the first note's
 * extraction was still running). Extraction has no one waiting on it, so it
 * yields; transcription never yields to extraction in the other direction.
 *
 * Build 42 P2-1 fix (qa/05-consolidated-triage.md P2-1): the original
 * schedule totaled only 6 seconds, but this same gate's own justifying
 * evidence (localLlama.ts's `WARMUP_TRANSCRIPTION_RECHECK_DELAYS_MS` doc
 * comment) documents a real on-device transcription ballooning to 24.4
 * seconds under contention — meaning the gate could give up and let
 * extraction proceed while the very transcription it was built to protect
 * was still running. Extended so the total wait comfortably exceeds that
 * measured worst case, while still terminating rather than waiting forever
 * for a transcription that (for whatever reason) never finishes. */
// Exported (in addition to internal use) purely so the Phase 2 test suite
// can assert the total wait comfortably exceeds the documented 24.4s
// worst-case contention measurement, without needing to actually drive a
// 29-second real timer in a unit test.
export const TRANSCRIPTION_RECHECK_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 10000];

async function waitForTranscriptionIdleIfNeeded(): Promise<void> {
  for (const delayMs of TRANSCRIPTION_RECHECK_DELAYS_MS) {
    if (!isTranscriptionInProgress()) {
      return;
    }
    console.log(`[TranscriptionGate] transcription in progress — deferring extraction ${delayMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.log("[TranscriptionGate] still transcribing after all retries — proceeding with extraction anyway.");
}

/**
 * Parses raw note text into structured to-do items entirely on-device, via
 * Xayra's existing llama.rn context (services/ai/localLlama.ts) — no network
 * call, no second model loaded into memory alongside the RAG one. Never
 * throws: a model that isn't downloaded yet, a malformed completion, or any
 * other failure resolves to an empty array rather than blocking whatever
 * caller is trying to save the underlying note.
 */
export async function extractToDosFromText(rawText: string): Promise<ExtractedToDo[]> {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return [];
  }

  // Hybrid Architecture: a deterministic pre-filter catches the specific
  // failure mode three real fine-tuning attempts (v5-v7) could not fix
  // reliably — see preFilterZeroTaskNotes's own doc comment in
  // extractionLogic.ts for the full rationale and the safety verification
  // this was checked against. Short-circuits BEFORE the thermal/
  // transcription waits below — there is no reason to defer for a warm
  // device just to return an empty array either way.
  if (preFilterZeroTaskNotes(trimmed)) {
    console.log("[transformationEngine] Pre-filter matched a zero-task note — skipping the LLM call.");
    return [];
  }

  const todayISO = todayIso();
  // Runs before the LLM call, entirely on the JS thread — see
  // detectDatePhrases's own doc comment. This is a plain synchronous regex/
  // pattern-matching pass, single-digit milliseconds, with zero interaction
  // with the shared llama.cpp context or the n_threads tuning in
  // localLlama.ts; it never competes with inference for CPU.
  const detectedPhrases = detectDatePhrases(trimmed, todayISO);

  try {
    await waitForCoolerThermalStateIfNeeded();
    await waitForTranscriptionIdleIfNeeded();
    const prompt = buildPrompt(trimmed, todayISO, detectedPhrases);

    const start = nowMs();
    // Routed through localLlama.ts's shared completion queue, not a direct
    // context.completion() call — extraction and RAG answers share one
    // native llama.cpp context, which allows only one in-flight completion
    // at a time. Several notes saved in quick succession used to fire
    // several of these concurrently and silently lose every one but the
    // first to "context is busy" (see runQueuedLlamaCompletion's own doc
    // comment for the on-device repro).
    const result = await runQueuedLlamaCompletion({
      prompt,
      n_predict: 512,
      // Fully greedy, not just "near-deterministic" — this is structured
      // extraction against a fixed schema, not open-ended conversation, so
      // there's no warmth/variety worth preserving the way localLlama.ts's
      // RAG generation tunes for. On-device testing found even temperature
      // 0.1 let the same exact note produce two DIFFERENT wrong answers
      // across two runs (one got the date right and recurrence wrong, the
      // other the reverse) — confusing on its own regardless of which run
      // happened to be more correct. temperature: 0 removes that source of
      // run-to-run inconsistency entirely; whatever the model's single best
      // read of a hard case is, it now gives the same answer to it every
      // time, which is itself worth having independent of raw accuracy.
      temperature: 0,
      // Grammar-constrained decoding — see TODO_EXTRACTION_GRAMMAR's own
      // comment for what this guarantees (and doesn't). `stop` is kept as a
      // belt-and-suspenders backstop, though grammar sampling should already
      // force EOS itself the moment the root rule's closing "]" is matched,
      // since no further character is valid under the grammar past that
      // point — this should rarely if ever actually trigger.
      grammar: TODO_EXTRACTION_GRAMMAR,
      stop: CHAT_TEMPLATE_STOP_TOKENS,
    },
    "background", // no one is waiting on this — always yields to a live "Ask" query already queued or arriving
    undefined,
    extractionPrefix(todayISO));
    logDuration("Llama to-do extraction", start);

    const rawOutput = result.text.trim();
    try {
      const parsed = parseExtractionOutput(rawOutput);
      // Logs the model's raw (pre-resolveDateAndTime) date_phrase per item —
      // added to diagnose a reported "to-dos always land on today regardless
      // of what date the note actually said" issue. This is the one place
      // that can tell apart the two very different failure modes: the model
      // itself extracting an empty/wrong date_phrase (a prompt/model
      // accuracy problem) vs. resolveDateAndTime/chrono-node failing to parse
      // a date_phrase the model got right (a date-resolution bug) — normalize
      // Extracted's return value only exposes the already-resolved
      // actionDate, which collapses both cases to the same "today" result.
      console.log("[transformationEngine] Raw extracted items (pre-date-resolution):", parsed);
      return normalizeExtracted(parsed, todayISO, trimmed, detectedPhrases);
    } catch (parseErr) {
      // Logged separately from the outer catch (which also covers
      // getContext()/completion failures) specifically so a parse failure
      // shows the actual text that broke it — "no JSON array found" alone
      // isn't diagnosable on its own, and this is a 1B/3B model, so it will
      // happen again on some future input shape.
      console.warn(
        "[transformationEngine] Failed to parse to-do extraction output — skipping.",
        parseErr,
        "Raw output:",
        rawOutput.slice(0, 500)
      );
      return [];
    }
  } catch (err) {
    console.warn("[transformationEngine] To-do extraction unavailable — skipping.", err);
    return [];
  }
}
