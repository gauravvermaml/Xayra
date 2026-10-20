import { IDLE_TAP_CUE } from "../../constants/copy";
import type { ProcessingJob } from "../ai/processingJob";
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

/** `cancelling`: Cancel was tapped while recording — the microphone is
 * being closed and the utterance thrown away; nothing will be processed. */
export type ManualUtterancePhase = "idle" | "starting" | "recording" | "processing" | "cancelling";

export type ManualUtteranceSnapshot = {
  phase: ManualUtterancePhase;
  /** What this utterance means, frozen when recording began; null when idle. */
  mode: UtteranceMode | null;
};

export type FinishTrigger = "tap" | "silence";

export type ManualUtteranceDeps = {
  /** False when the start was cancelled before the microphone opened. */
  startRecording: (options: StartRecordingOptions) => Promise<boolean | void>;
  /** Stops capture and returns the WAV uri (null if nothing was recording). */
  stopRecording: () => Promise<string | null>;
  /** Stops capture and throws the audio away — no WAV is written. Also
   * aborts a start that hasn't opened the microphone yet. */
  discardRecording: () => Promise<void>;
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
  /** The recording has just ended (silence or tap) — before the audio is
   * finalized — with the utterance's mode. */
  onCaptureEnd?: (mode: UtteranceMode) => void;
  /** The ended recording produced nothing to process (no audio / stop
   * failed), so whatever onCaptureEnd prepared should be undone. */
  onCaptureDiscarded?: () => void;
  /** The microphone could not be stopped while cancelling. It may still be
   * capturing, so the utterance stays in "recording" (Finish and Cancel
   * still apply) rather than claiming the microphone is free. */
  onCancelCleanupError?: (error: unknown) => void;
};

export class ManualUtteranceController {
  private readonly deps: ManualUtteranceDeps;
  private phase: ManualUtterancePhase = "idle";
  private mode: UtteranceMode | null = null;
  private disposed = false;
  /** Increments per start, so a Cancel aimed at one recording can never
   * land on a later one. */
  private currentUtteranceId = 0;

  constructor(deps: ManualUtteranceDeps) {
    this.deps = deps;
  }

  get snapshot(): ManualUtteranceSnapshot {
    return { phase: this.phase, mode: this.mode };
  }

  /** The id of the most recently started utterance. */
  get utteranceId(): number {
    return this.currentUtteranceId;
  }

  private set(phase: ManualUtterancePhase, mode: UtteranceMode | null): void {
    this.phase = phase;
    this.mode = mode;
    if (!this.disposed) this.deps.onChange?.(this.snapshot);
  }

  /** The owning screen is gone: an utterance it started must never be
   * finished or processed later by it (its recorder stops capture itself). */
  dispose(): void {
    this.disposed = true;
    this.phase = "idle";
    this.mode = null;
  }

  /** Begins recording an utterance that will mean `mode` — whatever the
   * Record/Ask control says by the time it's processed. */
  async start(mode: UtteranceMode): Promise<void> {
    if (this.phase !== "idle" || this.disposed) {
      return;
    }
    this.currentUtteranceId += 1;
    const utteranceId = this.currentUtteranceId;
    this.set("starting", mode);
    try {
      const started = await this.deps.startRecording({
        autoStopAfterSilenceMs: AUTO_STOP_TRAILING_SILENCE_MS[mode],
        // Bound to this utterance: a late silence callback can never
        // finish a newer recording.
        onAutoStop: () => void this.finish("silence", utteranceId),
      });
      // Cancelled while the microphone was opening: if it opened anyway
      // (the start was past its abort point), close it and throw it away.
      if (this.isCancelling()) {
        if (started !== false) await this.discardQuietly();
        this.set("idle", null);
        return;
      }
      if (started === false || this.disposed) {
        if (!this.disposed) this.set("idle", null);
        return;
      }
      this.set("recording", mode);
    } catch (err) {
      const wasCancelled = this.isCancelling();
      this.set("idle", null);
      // A start the user already cancelled has nothing left to report.
      if (!wasCancelled) throw err;
    }
  }

  /**
   * Cancel during recording: closes the microphone and throws the
   * utterance away — never transcribed, saved or asked. Shares the
   * synchronous phase gate with `finish`, so whichever of Cancel, a tap or
   * the silence detector comes first wins and the others are no-ops. Once
   * capture has ended (processing), this does nothing: the processing
   * Cancel applies from there. `utteranceId`, when given, must still be the
   * current utterance. Returns whether this call cancelled it; the
   * controller is idle again by the time a recording cancel resolves —
   * unless the microphone couldn't be stopped, in which case the utterance
   * goes back to "recording" (the microphone may still be capturing, so it
   * is never reported free) and this returns false.
   */
  async cancel(utteranceId?: number): Promise<boolean> {
    if (this.disposed) return false;
    if (utteranceId !== undefined && utteranceId !== this.currentUtteranceId) return false;
    if (this.phase === "starting") {
      // start() finishes the cleanup once the microphone call returns.
      this.set("cancelling", this.mode);
      await this.discardQuietly();
      return true;
    }
    if (this.phase !== "recording") return false;
    const mode = this.mode;
    this.set("cancelling", mode);
    if (!(await this.discardQuietly())) {
      this.set("recording", mode);
      return false;
    }
    this.set("idle", null);
    return true;
  }

  /** Read through a method: the phase changes across awaits, which a
   * direct comparison's narrowing can't see. */
  private isCancelling(): boolean {
    return this.phase === "cancelling";
  }

  /** False if the microphone could not be stopped. */
  private async discardQuietly(): Promise<boolean> {
    try {
      await this.deps.discardRecording();
      return true;
    } catch (err) {
      this.deps.onCancelCleanupError?.(err);
      return false;
    }
  }

  /**
   * Finishes the recording now — from a tap or the silence detector,
   * whichever comes first; the other is then a no-op. The mode is the one
   * captured at `start`, never re-read. `utteranceId`, when given, must
   * still be the current utterance.
   */
  async finish(trigger: FinishTrigger, utteranceId?: number): Promise<void> {
    if (this.phase !== "recording" || !this.mode || this.disposed) {
      return;
    }
    if (utteranceId !== undefined && utteranceId !== this.currentUtteranceId) {
      return;
    }
    const mode = this.mode;
    this.set("processing", mode);
    this.deps.onCaptureEnd?.(mode);
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
      } else {
        this.deps.onCaptureDiscarded?.();
      }
    } catch (err) {
      this.deps.onCaptureDiscarded?.();
      this.deps.onError?.(err);
    } finally {
      release();
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
 * The controls under the emblem during a manual recording: Cancel while it
 * is capturing; Finish too, but only when the emblem — whose tap is the
 * normal Finish — is hidden on a constrained screen. Never for Handsfree,
 * which keeps its own tap-to-discard.
 */
export function recordingActionsFor(state: {
  isCapturing: boolean;
  isHandsfreeActive: boolean;
  emblemHidden: boolean;
}): { cancel: boolean; finish: boolean } {
  const cancel = state.isCapturing && !state.isHandsfreeActive;
  return { cancel, finish: cancel && state.emblemHidden };
}

/**
 * Cancel the job that's processing, if it still can be: the job's own
 * listeners start the real aborts (Whisper decode, LLM generation) and
 * every later step discards its result. Returns whether anything was
 * cancelled — false for no job, an already-cancelled job, or one past its
 * point of no return.
 */
export function cancelProcessing(job: ProcessingJob | null): boolean {
  return job?.cancel() ?? false;
}

/**
 * What a tap on the central button will do — only when truly idle: not
 * recording, processing, starting, or in Handsfree (whose own status is
 * authoritative). The live status line owns every other state.
 */
export function idleTapCue(state: {
  canvasState: "idle" | "recording" | "transcribing" | "listening";
  manualPhase: ManualUtterancePhase;
  isHandsfreeActive: boolean;
  mode: UtteranceMode;
}): string | null {
  if (state.canvasState !== "idle" || state.manualPhase !== "idle" || state.isHandsfreeActive) return null;
  return IDLE_TAP_CUE[state.mode];
}

/** While the mic is capturing a manual utterance. */
export const LISTENING_STATUS = "Listening… I’ll finish when you’re done";
/** The moment capture ends (silence or tap), and any gap between real
 * stages — never implies work that isn't happening. */
export const ACKNOWLEDGED_STATUS = "Got it";

/** Ask's retrieval/inference progress is shown in ONE place — the pending
 * answer bubble in the tray — never duplicated under the central button. */
const ASK_TRAY_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>(["retrieving", "answering"]);

/**
 * The status line under the central button. Listening copy only while the
 * mic is actually capturing; once capture has ended it acknowledges ("Got
 * it", which is also the transcription stage's label). Record then follows
 * its real stages (understanding → saving) here; Ask's retrieval and
 * inference progress lives in the tray's answer bubble instead, so this
 * line goes quiet (Handsfree keeps its tap-to-cancel hint).
 */
export function centralStatusText(state: {
  phase: "recording" | "stopping" | "processing" | "idle";
  pipelineStage: PipelineStage | null;
  isHandsfreeActive: boolean;
  /** A manual voice Ask whose recording has ended: from that moment its
   * whole progress (Got it… onwards) lives in the tray, so this line stays
   * empty (the Cancel button remains). */
  isVoiceAskInTray?: boolean;
}): string | null {
  if (state.phase === "recording") return LISTENING_STATUS;
  if (state.phase === "idle") return null;
  if (state.isVoiceAskInTray) return null;
  if (state.phase === "processing" && state.pipelineStage && ASK_TRAY_STAGES.has(state.pipelineStage)) {
    return state.isHandsfreeActive ? "Tap to cancel" : null;
  }
  const label =
    state.phase === "processing" && state.pipelineStage ? PIPELINE_STAGE_LABELS[state.pipelineStage] : ACKNOWLEDGED_STATUS;
  // Handsfree keeps its "tap to cancel" gesture and hint; everything else
  // cancels through the explicit Cancel action.
  return state.isHandsfreeActive ? `${label} · tap to cancel` : label;
}

/** What Xayra says after a Record utterance: "Saved." only when a note was
 * actually written — never for a recording discarded as empty or silent. */
export function recordCompletionSpeech(noteSaved: boolean | undefined): string | null {
  return noteSaved ? "Saved." : null;
}
