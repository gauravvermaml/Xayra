import { cancelActiveLlamaCompletion } from "../ai/localLlama";
import { cancelActiveTranscription } from "../ai/localWhisper";
import { PIPELINE_STAGE_LABELS, type PipelineStage } from "../ai/pipelineStage";
import type { StartRecordingOptions } from "./recorder";

/**
 * The central button's manual voice utterance: tap → speak → Xayra finishes
 * on its own once you've stopped talking (or on a second tap) → transcribe
 * → save (Record) or answer (Ask).
 *
 * Framework-agnostic (no React) so the tap policy and the per-utterance
 * mode freeze can be tested directly; app/index.tsx wires it to the
 * recorder and the shared pipeline.
 */

export type UtteranceMode = "record" | "ask";

/**
 * Trailing silence after speech before a manual recording finishes itself.
 * Product-tuning values, not model logic: a question is usually one breath,
 * while a journal entry has thinking pauses that mustn't cut it short.
 */
export const AUTO_STOP_TRAILING_SILENCE_MS: Record<UtteranceMode, number> = {
  ask: 1500,
  record: 2200,
};

export type ManualUtterancePhase = "idle" | "starting" | "recording" | "processing";

export type ManualUtteranceSnapshot = {
  phase: ManualUtterancePhase;
  /** What this utterance means, frozen when recording began; null when idle. */
  mode: UtteranceMode | null;
};

export type FinishTrigger = "tap" | "silence";

export type ManualUtteranceDeps = {
  startRecording: (options: StartRecordingOptions) => Promise<void>;
  /** Stops capture and returns the WAV uri (null if nothing was recording). */
  stopRecording: () => Promise<string | null>;
  /** Runs the shared transcribe → save/answer pipeline for one utterance,
   * with the mode it was recorded in. Calls `release` once the note is
   * saved / the answer is ready, so speaking the result doesn't hold the
   * utterance open (a tap during that speech starts a new recording, as
   * before). */
  processUtterance: (
    audioUri: string,
    mode: UtteranceMode,
    trigger: FinishTrigger,
    release: () => void
  ) => Promise<void>;
  onChange?: (snapshot: ManualUtteranceSnapshot) => void;
  onError?: (error: unknown) => void;
};

export class ManualUtteranceController {
  private readonly deps: ManualUtteranceDeps;
  private phase: ManualUtterancePhase = "idle";
  private mode: UtteranceMode | null = null;

  constructor(deps: ManualUtteranceDeps) {
    this.deps = deps;
  }

  get snapshot(): ManualUtteranceSnapshot {
    return { phase: this.phase, mode: this.mode };
  }

  private set(phase: ManualUtterancePhase, mode: UtteranceMode | null): void {
    this.phase = phase;
    this.mode = mode;
    this.deps.onChange?.(this.snapshot);
  }

  /** Begins recording an utterance that will mean `mode` — whatever the
   * Record/Ask control says by the time it's processed. */
  async start(mode: UtteranceMode): Promise<void> {
    if (this.phase !== "idle") {
      return;
    }
    this.set("starting", mode);
    try {
      await this.deps.startRecording({
        autoStopAfterSilenceMs: AUTO_STOP_TRAILING_SILENCE_MS[mode],
        onAutoStop: () => void this.finish("silence"),
      });
      this.set("recording", mode);
    } catch (err) {
      this.set("idle", null);
      throw err;
    }
  }

  /**
   * Finishes the recording now — from a tap or the silence detector,
   * whichever comes first; the other is then a no-op. The mode is the one
   * captured at `start`, never re-read.
   */
  async finish(trigger: FinishTrigger): Promise<void> {
    if (this.phase !== "recording" || !this.mode) {
      return;
    }
    const mode = this.mode;
    this.set("processing", mode);
    // Idempotent, so a late release can never clobber a newer utterance
    // started after this one was released.
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.set("idle", null);
      }
    };
    try {
      const audioUri = await this.deps.stopRecording();
      if (audioUri) {
        await this.deps.processUtterance(audioUri, mode, trigger, release);
      }
    } catch (err) {
      this.deps.onError?.(err);
    } finally {
      release();
    }
  }

  /** The recording was stopped elsewhere and thrown away (e.g. leaving the
   * screen) — forget it without processing. */
  abandon(): void {
    if (this.phase === "recording" || this.phase === "starting") {
      this.set("idle", null);
    }
  }
}

export type CentralTapAction =
  /** Manual recording in progress: finish it now. */
  | "finish-manual"
  /** Nothing in flight: start a manual recording. */
  | "start-manual"
  /** Handsfree's own processing: tap still cancels it, as before. */
  | "cancel-handsfree-processing"
  /** Handsfree capturing: tap discards the utterance, as before. */
  | "cancel-handsfree-capture"
  /** Processing (or mid-transition): the tap does nothing — cancelling is
   * the explicit Cancel action's job. */
  | "ignore";

/**
 * What a tap on the central Xayra button means. Once a manual utterance is
 * processing, a tap must NOT cancel it: recording now finishes on its own,
 * so a habitual "second tap" can land just after it did, and silently
 * throwing away the note or question would be the wrong outcome. Handsfree
 * taps keep their existing meaning.
 */
export function decideCentralTap(state: {
  manualPhase: ManualUtterancePhase;
  isProcessing: boolean;
  isHandsfreeActive: boolean;
  isRecorderTransitioning: boolean;
}): CentralTapAction {
  if (state.manualPhase === "recording") return "finish-manual";
  if (state.manualPhase !== "idle") return "ignore";
  if (state.isProcessing) return state.isHandsfreeActive ? "cancel-handsfree-processing" : "ignore";
  if (state.isHandsfreeActive) return "cancel-handsfree-capture";
  if (state.isRecorderTransitioning) return "ignore";
  return "start-manual";
}

/**
 * Cancel whatever is processing: the flag is checked by the pipeline before
 * a note is saved or a query routed, and transcription / generation are cut
 * off immediately if running (both are no-ops when nothing is in flight).
 */
export function cancelProcessing(cancelRequested: { current: boolean }): void {
  cancelRequested.current = true;
  cancelActiveTranscription();
  cancelActiveLlamaCompletion();
}

/** While the mic is capturing a manual utterance. */
export const LISTENING_STATUS = "Listening… I’ll finish when you’re done";
/** The moment capture ends (silence or tap), and any gap between real
 * stages — never implies work that isn't happening. */
export const ACKNOWLEDGED_STATUS = "Got it";

/**
 * The status line under the central button. Listening copy only while the
 * mic is actually capturing; once capture has ended it acknowledges ("Got
 * it", which is also the transcription stage's label) and then follows
 * the real pipeline stages — Ask: retrieving → answering; Record:
 * understanding → saving.
 */
export function centralStatusText(state: {
  phase: "recording" | "stopping" | "processing" | "idle";
  pipelineStage: PipelineStage | null;
  isHandsfreeActive: boolean;
}): string | null {
  if (state.phase === "recording") return LISTENING_STATUS;
  if (state.phase === "idle") return null;
  const label =
    state.phase === "processing" && state.pipelineStage ? PIPELINE_STAGE_LABELS[state.pipelineStage] : ACKNOWLEDGED_STATUS;
  // Handsfree keeps its "tap to cancel" gesture and hint; everything else
  // cancels through the explicit Cancel action.
  return state.isHandsfreeActive ? `${label} · tap to cancel` : label;
}
