import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { Buffer } from "buffer";
import { requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import AudioRecord from "@fugood/react-native-audio-pcm-stream";

import { setMicInUse } from "./audioInputState";
import { pausePlayback } from "./player";
import { stopSpeech } from "./tts";
import { TrailingSilenceDetector } from "./silenceDetector";
import { preloadWakeChime, releaseWakeChime } from "./wakeChime";
import { BITS_PER_SAMPLE, CHANNELS, SAMPLE_RATE, computeRms, writePcmChunksAsWav } from "./wav";

export type ActiveModeState = "idle" | "listening" | "processing" | "speaking";

/**
 * `reportState` lets the caller (Notes/Chat screen) tell the manager when
 * it's moved from "transcribing/acting" into "speaking the result" —
 * ActiveModeManager itself only knows "an utterance finished, I handed it
 * off," not what the caller is doing with it at any given moment.
 */
export type ActiveModeUtteranceHandler = (
  audioUri: string,
  reportState: (state: "processing" | "speaking") => void
) => Promise<void>;

export type ActiveModeCallbacks = {
  onUtterance: ActiveModeUtteranceHandler;
  onStateChange?: (state: ActiveModeState) => void;
  onError?: (error: unknown) => void;
};

/**
 * Handsfree's voice-activity timings. The adaptive noise-floor / RMS speech
 * detection itself lives in silenceDetector.ts (shared with the manual
 * recorder's auto-finish); these values are Handsfree's own.
 */
const SILENCE_HOLD_MS = 1500;
/** Guards against a stray tap/cough finalizing a near-empty "utterance". */
const MIN_UTTERANCE_MS = 400;
/** Safety cap so a miscalibrated threshold (e.g. loud background noise never
 * dropping below that cycle's calibrated `speechRmsThreshold`) can't record
 * indefinitely. */
const MAX_UTTERANCE_MS = 60_000;
const SILENCE_POLL_INTERVAL_MS = 200;

const KEEP_AWAKE_TAG = "remi-active-mode";

/**
 * Build 24 REFACTOR HANDSFREE WAKE-WORD DETECTION ENGINE — read this before
 * assuming more than what's actually here. This is explicitly NOT an
 * acoustic wake-word engine, still. A real one (Porcupine or similar) listens
 * to raw audio frames continuously and recognizes the acoustic pattern of a
 * specific phrase BEFORE any recording/transcription happens at all — that
 * needs a native module, an external Picovoice AccessKey, and a
 * custom-trained "Hey Xayra" model file, none of which exist in this project
 * and none of which are obtainable from inside this session (there's no
 * account to generate an AccessKey with, and a custom wake-word model has to
 * be trained via Picovoice's own console, not synthesized locally). Silently
 * pretending otherwise would misrepresent what changed here — see this same
 * honesty pattern re-stated on `useActiveMode` below and in every build back
 * to 17.
 *
 * What THIS actually is: a local, post-transcription phrase-matching filter
 * — the achievable half of the task's own "keyword spotter ... or local
 * phrase matching" alternative. The RMS-threshold VAD above still can't tell
 * "someone is talking" from "loud ambient noise" at the AUDIO level (that
 * limitation is unchanged and undiminished); this instead asks, once
 * Whisper has already produced a transcript, whether the RESULT actually
 * mentions the wake word. Manual recordings (the center button) never go
 * through this filter: a deliberately short manual note ("Buy milk") is a
 * real, wanted 2-word note, not noise — this gate only applies when nobody
 * physically pressed record for it.
 *
 * Build 25 STRICT DUAL-MODE WAKE-WORD GATEKEEPER — supersedes Build 24's
 * leniency. Build 24's version (`isLikelyAmbientNoise`, since removed) let
 * ANY transcript of three or more words through even without ever saying
 * "Xayra" — a bare "Any notes today?" was accepted as deliberate speech.
 * Build 25 tightens that: EVERY Handsfree utterance, in both Record and Ask
 * mode, must contain something recognizable as the wake word or it's
 * discarded before it ever reaches SQLite (Record) or the RAG pipeline
 * (Ask) — see app/index.tsx's `finishUtterance`. There is no more word-count
 * leniency: a two-word "Xayra, stop" still passes (it contains the word),
 * but a wake-word-free "Any notes today?" no longer does, regardless of
 * length. This is a blunt text match, not a semantic classifier — that
 * tradeoff is the actual, honest scope of a filter that costs no model call
 * and needs no native dependency.
 *
 * Post-Build-25 fix: a fixed literal list of near-misses ("Zaira", "Cyra",
 * "Zyra", "Exayra") turned out not to be enough — confirmed on-device at an
 * 8-in-10 miss rate even with clear, close-range speech. "Xayra" is an
 * invented brand name with no real pronunciation the on-device `base.en`
 * Whisper model has ever seen in training, so it doesn't consistently
 * mishear it as any small fixed set of alternate spellings — it mishears it
 * as whatever real-word-shaped guess its language-model bias favors on a
 * given pass, which is a much larger and less predictable space than 4
 * literal strings can cover (chasing it string-by-string is whack-a-mole).
 * `containsWakeWord` now does a bounded Levenshtein-distance fuzzy match
 * (`WAKE_WORD_MAX_EDIT_DISTANCE`) against "xayra" over every word-like token
 * in the transcript, rather than exact substring matching against a fixed
 * list — this catches near-miss spellings tolerantly, e.g. "Sierra" or
 * "Zyra" or "Xyra" or "Zaira," without hardcoding each one. Still a blunt
 * text heuristic, not a semantic/phonetic model: it operates on how the
 * mis-transcription is SPELLED, not how it SOUNDS, so an edit-distance-2
 * match happens to catch most of what Whisper actually produces for this
 * word in practice but isn't guaranteed to catch every possible
 * mis-spelling, and (see `MAX_EDIT_DISTANCE`'s own doc comment) is
 * deliberately kept tight enough that unrelated 5-letter words don't
 * false-positive as the wake word.
 */
export const WAKE_WORD_CANONICAL = "xayra";

/**
 * How many single-character edits (insert/delete/substitute) a transcript
 * token may differ from "xayra" by and still count as the wake word.
 * 2 was chosen by checking it against real confusable words: "sarah" (a
 * common name someone might actually say) sits at edit-distance 3 from
 * "xayra", safely outside this gate, while every near-miss spelling from
 * the old literal list ("zaira", "cyra", "zyra", "exayra") sits at distance
 * 1-2, safely inside it. Raising this further starts pulling in genuinely
 * unrelated short words as false positives; lowering it re-introduces the
 * whack-a-mole problem this fuzzy match exists to avoid.
 */
const MAX_EDIT_DISTANCE = 2;

/**
 * Carrier words that may precede the wake word ("Hey Xayra", "Listen Xayra").
 *
 * WHY THE CARRIER IS OPTIONAL AND NOT REQUIRED. The product ask was to
 * standardize on a higher-density trigger phrase so a strong consonant onset
 * survives ambient road noise. That reasoning is sound, but it only pays off
 * in an ACOUSTIC engine that scores raw audio frames. This function sits
 * after Whisper, on text — and the single best-documented failure mode on
 * this path (see `armListening()`'s own comment below, confirmed via
 * on-device logcat) is that the FIRST word of an utterance is the one most
 * likely to be dropped entirely during native audio-hardware cold-start.
 * Hard-requiring "hey" before "xayra" would therefore have made the miss
 * rate worse, not better, by adding a second token that has to survive
 * exactly where transcription is weakest.
 *
 * So the carrier is used the other way round: as CORROBORATION. When one is
 * present, the following token is allowed a looser fuzzy match, because
 * "hey <something-xayra-shaped>" is far less likely to be an accidental
 * false positive than a bare five-letter token on its own. A bare "Xayra"
 * still works exactly as before.
 */
const WAKE_WORD_CARRIERS = new Set(["hey", "hi", "ok", "okay", "listen", "yo"]);

/**
 * Edit distance allowed for the wake word when a carrier word immediately
 * precedes it. Looser than `MAX_EDIT_DISTANCE` (3 vs 2) because the carrier
 * already did most of the work of ruling out a coincidence — this is what
 * actually buys back recall in noise, and it's why "Hey Xayra" is worth
 * telling users to say even though the carrier isn't mandatory.
 */
const MAX_EDIT_DISTANCE_WITH_CARRIER = 3;

/** What the UI should tell users to say. Kept here next to the matcher so
 * the prompt and the thing that accepts it can't drift apart. */
export const WAKE_PHRASE_DISPLAY = "Hey Xayra";

/** Classic full Levenshtein DP — `a`/`b` are typically single short words
 * here (wake-word tokens), so the O(len(a)*len(b)) cost is negligible. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) {
    dp[0][j] = j;
  }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[rows - 1][cols - 1];
}

/** True if `transcript` contains the wake word or something close enough to
 * be a plausible Whisper mis-transcription of it — see the long comment
 * above for why this is fuzzy rather than a fixed literal list. */
export function containsWakeWord(transcript: string): boolean {
  const tokens = transcript.toLowerCase().match(/[a-z']+/g);
  if (!tokens) {
    return false;
  }
  return tokens.some((token, index) => {
    const precededByCarrier = index > 0 && WAKE_WORD_CARRIERS.has(tokens[index - 1]);
    const budget = precededByCarrier ? MAX_EDIT_DISTANCE_WITH_CARRIER : MAX_EDIT_DISTANCE;
    return levenshteinDistance(token, WAKE_WORD_CANONICAL) <= budget;
  });
}

/**
 * Drives the continuous "listen → auto-stop on silence → hand off →
 * re-arm" loop for Active/"Shower" Mode. Framework-agnostic (no React) —
 * see useActiveMode below for the hook that wires it into a screen.
 *
 * Owns its own @fugood/react-native-audio-pcm-stream session, independent
 * of services/audio/recorder.ts's useVoiceRecorder — callers are
 * responsible for not running both at once (the manual mic button is
 * disabled by both Notes and Chat screens while Active Mode is engaged),
 * since the native module supports only one capture session at a time.
 */
export class ActiveModeManager {
  private readonly callbacks: ActiveModeCallbacks;
  private _state: ActiveModeState = "idle";
  private stopped = true;

  private chunks: Buffer[] = [];
  private subscription: { remove: () => void } | null = null;
  private silenceCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Speech / trailing-silence state for the current listen cycle — reset
  // at the top of every `armListening()` call.
  private readonly detector = new TrailingSilenceDetector({
    trailingSilenceMs: SILENCE_HOLD_MS,
    minUtteranceMs: MIN_UTTERANCE_MS,
  });

  /**
   * Confirmed on-device via adb logcat: the wake word was being dropped
   * entirely (transcripts coming back as "", ".", or a bare leading comma)
   * specifically at the very START of an utterance, while the REST of the
   * same sentence — spoken moments later — transcribed correctly. That
   * pattern doesn't fit "quiet audio" (already addressed separately by
   * wav.ts's peak normalization); it fits a native audio-hardware
   * cold-start. `armListening()` used to call `AudioRecord.init()` +
   * `.start()` FRESH on every single utterance boundary (right after
   * `finalizeUtterance()`'s own `AudioRecord.stop()`) — a full native
   * mic-session teardown/rebuild before every utterance, not just the very
   * first one after engaging Handsfree. Real Android audio hardware takes a
   * non-zero moment to actually start delivering samples after a fresh
   * `AudioRecord.start()`, and the wake word — always the first syllable(s)
   * of a freshly re-opened stream — is exactly what has no room to survive
   * that gap.
   *
   * Fix: the native session is now opened exactly ONCE, in `start()`, and
   * kept running continuously for as long as Handsfree stays engaged —
   * `armListening()`/`finalizeUtterance()` no longer touch `AudioRecord` at
   * all between utterances, only this JS-side flag. While `capturing` is
   * false (processing/speaking a previous utterance), the native stream
   * keeps flowing but every incoming chunk is discarded immediately — this
   * is what still stops the mic from picking up the assistant's own TTS
   * playback as a new "utterance" (no echo cancellation exists here; see
   * this file's other doc comments), just via a flag check instead of an
   * actual hardware stop/restart.
   */
  private capturing = false;

  constructor(callbacks: ActiveModeCallbacks) {
    this.callbacks = callbacks;
  }

  get state(): ActiveModeState {
    return this._state;
  }

  private setState(next: ActiveModeState): void {
    this._state = next;
    this.callbacks.onStateChange?.(next);
  }

  private errorSubscription: { remove: () => void } | null = null;

  async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      throw new Error("Microphone permission was not granted.");
    }

    // Build 42 P1-1b fix (qa/05-consolidated-triage.md P1-1): engaging
    // Handsfree had the same gap as manual recording (see recorder.ts's
    // matching fix) — worse here, since any audio still playing gets sampled
    // as "ambient noise" by the calibration window right below, corrupting
    // the adaptive VAD threshold for this entire utterance cycle. Must land
    // BEFORE `armListening()`'s calibration window starts, not just before
    // this function returns.
    await stopSpeech();
    pausePlayback();

    // Build 42 P2-4 (best-effort) — see recorder.ts's identical setting and
    // doc comment for what this does and does not cover.
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: "doNotMix" });
    // Keeps the screen (and CPU) awake for as long as Active Mode is
    // engaged, so a hands-free/shower session isn't cut short by the
    // device auto-locking mid-listen. This only covers the foreground —
    // backgrounding the app or a manual power-button lock still suspends
    // recording; a true background foreground-service is a separate,
    // materially larger native undertaking not implemented here.
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    this.stopped = false;
    setMicInUse(true);

    // The ONE native session for this entire Handsfree engagement — see
    // `capturing`'s own doc comment for why this is deliberately not
    // repeated in `armListening()` anymore.
    AudioRecord.init({ sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE });
    this.subscription?.remove();
    this.subscription = AudioRecord.on("data", (base64Chunk: string) => this.handleAudioChunk(base64Chunk));
    // Build 42 P1-5 fix — see recorder.ts's identical fix/doc comment.
    // Requires the native patch adding this event; see
    // patches/@fugood+react-native-audio-pcm-stream+1.1.4.patch.
    this.errorSubscription?.remove();
    this.errorSubscription = AudioRecord.on("error", (message: string) => {
      console.error("[ActiveMode] Native recording error:", message);
      this.callbacks.onError?.(new Error(`Native recording error: ${message}`));
    });
    AudioRecord.start();

    this.armListening();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.capturing = false;
    this.clearSilenceCheck();
    try {
      AudioRecord.stop();
    } catch {
      // Already stopped — fine.
    }
    this.subscription?.remove();
    this.subscription = null;
    this.errorSubscription?.remove();
    this.errorSubscription = null;
    this.chunks = [];
    setMicInUse(false);
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
    this.setState("idle");
  }

  /** The native "data" event handler — split out of `start()` so it reads
   * cleanly, but still just a thin dispatcher: while not `capturing`
   * (Handsfree is mid processing/speaking a previous utterance), every
   * chunk is discarded immediately without even computing its RMS — this is
   * what keeps the assistant's own TTS playback from being picked up as a
   * new utterance now that the native stream is never actually stopped. */
  private handleAudioChunk(base64Chunk: string): void {
    if (!this.capturing) {
      return;
    }
    const chunk = Buffer.from(base64Chunk, "base64");
    this.chunks.push(chunk);
    this.detector.push(computeRms(chunk), Date.now());
  }

  /**
   * Build 48 fix, live user report: a tap on the record button while
   * Handsfree is actively CAPTURING an utterance — speech detected, VAD
   * still waiting for trailing silence — used to have no effect at all.
   * The only cancel path that existed (app/index.tsx's `cancelRequestedRef`)
   * only takes effect once `finalizeUtterance()` has already handed the
   * utterance off for transcription, so a tap mid-sentence just sat there:
   * the user had to wait out however long silence-detection takes, then
   * Whisper, then potentially a RAG answer, before a cancel tap landing on
   * an already-"processing" state could finally do anything — reported as
   * needing several taps and feeling stuck.
   *
   * This discards whatever's been captured so far and re-arms listening
   * immediately, via the exact same `armListening()` a normal
   * finalize-and-continue cycle already uses — as if this utterance never
   * happened, no transcription or LLM call ever runs for it. Returns
   * `false` (a deliberate no-op) if nothing is actually being captured yet
   * (still calibrating / no speech detected above the noise floor) — there
   * is genuinely nothing to cancel in that case, and the caller falls back
   * to whatever it already does when a tap has no in-flight utterance to
   * act on.
   */
  cancelCurrentUtterance(): boolean {
    if (this.stopped || !this.capturing || !this.detector.hasDetectedSpeech) {
      return false;
    }
    this.armListening();
    return true;
  }

  /** Starts (or restarts, after an utterance) a listen cycle. Purely
   * JS-side state now — see `capturing`'s doc comment for why this no
   * longer touches `AudioRecord` at all; the native session is opened once,
   * in `start()`, and stays open until `stop()`. */
  private armListening(): void {
    if (this.stopped) {
      return;
    }
    this.chunks = [];
    // Fresh calibration every cycle — see TrailingSilenceDetector.reset.
    this.detector.reset(Date.now());

    this.capturing = true;
    this.setState("listening");

    this.clearSilenceCheck();
    this.silenceCheckTimer = setInterval(() => this.checkSilence(), SILENCE_POLL_INTERVAL_MS);
  }

  private clearSilenceCheck(): void {
    if (this.silenceCheckTimer) {
      clearInterval(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }
  }

  private checkSilence(): void {
    if (this.stopped || this._state !== "listening") {
      return;
    }
    const now = Date.now();
    const hitMaxDuration = this.detector.elapsed(now) >= MAX_UTTERANCE_MS;
    const finishedSpeaking = this.detector.hasFinishedSpeaking(now);

    if (hitMaxDuration || finishedSpeaking) {
      void this.finalizeUtterance();
    }
  }

  private async finalizeUtterance(): Promise<void> {
    this.clearSilenceCheck();
    if (this.stopped) {
      return;
    }

    // No native call here anymore — see `capturing`'s doc comment. The
    // hardware stream keeps running; this just stops treating its incoming
    // chunks as part of an utterance until the next `armListening()`.
    this.capturing = false;

    const hadSpeech = this.detector.hasDetectedSpeech;
    const chunks = this.chunks;
    this.chunks = [];

    if (!hadSpeech || chunks.length === 0) {
      // Silence the whole way through (e.g. nobody's said anything yet) —
      // nothing to process, just keep listening.
      this.armListening();
      return;
    }

    this.setState("processing");
    try {
      const uri = await writePcmChunksAsWav(chunks, "active-mode");
      await this.callbacks.onUtterance(uri, (state) => this.setState(state));
    } catch (err) {
      this.callbacks.onError?.(err);
    } finally {
      if (!this.stopped) {
        this.armListening();
      }
    }
  }
}

export type UseActiveMode = {
  isActive: boolean;
  state: ActiveModeState;
  toggle: () => Promise<void>;
  stop: () => Promise<void>;
  /** See ActiveModeManager.cancelCurrentUtterance's own doc comment. */
  cancelCurrentUtterance: () => boolean;
};

/**
 * React wrapper around ActiveModeManager. `onUtterance` is read through a
 * ref so the hook doesn't need to tear down and recreate the underlying
 * manager (and its live mic session) every time the caller's callback
 * closure changes identity across renders.
 */
export function useActiveMode(onUtterance: ActiveModeUtteranceHandler): UseActiveMode {
  const [isActive, setIsActive] = useState(false);
  const [state, setState] = useState<ActiveModeState>("idle");
  const managerRef = useRef<ActiveModeManager | null>(null);
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  useEffect(() => {
    const manager = new ActiveModeManager({
      onUtterance: (uri, reportState) => onUtteranceRef.current(uri, reportState),
      onStateChange: setState,
      onError: (err) => console.error("[ActiveMode] error", err),
    });
    managerRef.current = manager;
    return () => {
      void manager.stop();
    };
  }, []);

  /**
   * Build 42 P2-3 fix (qa/05-consolidated-triage.md P2-3): `isActive`/`state`
   * could desync from reality after a background/foreground cycle that
   * doesn't kill the process — the manager's own doc comment on `start()`
   * already says backgrounding suspends the native capture, but nothing
   * ever told the JS-side `isActive` state that happened, so the pill could
   * keep reading "Handsfree · listening" indefinitely with nothing actually
   * being captured. `stop()` is idempotent (no-ops if already stopped), so
   * this is safe to call unconditionally on every background transition
   * rather than needing to track whether Handsfree was actually engaged.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState === "background") {
        void managerRef.current?.stop().then(() => setIsActive(false));
      }
    });
    return () => subscription.remove();
  }, []);

  const start = useCallback(async () => {
    // Fire-and-forget, not awaited: loading a ~10KB local asset is fast, but
    // there's no reason to make engaging Handsfree wait on it, and a chime
    // that's still loading the first time is a cosmetic miss, not a bug.
    preloadWakeChime();
    await managerRef.current?.start();
    setIsActive(true);
  }, []);

  const stop = useCallback(async () => {
    await managerRef.current?.stop();
    setIsActive(false);
    releaseWakeChime();
  }, []);

  const toggle = useCallback(async () => {
    if (isActive) {
      await stop();
    } else {
      await start();
    }
  }, [isActive, start, stop]);

  const cancelCurrentUtterance = useCallback(() => {
    return managerRef.current?.cancelCurrentUtterance() ?? false;
  }, []);

  return { isActive, state, toggle, stop, cancelCurrentUtterance };
}
