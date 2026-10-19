import type { ProcessingJob } from "../ai/processingJob";

/**
 * Explicit Handsfree Stop (Xayra 2.0 Stage 5b correction): stopping
 * Handsfree stops the interaction in progress, not just the listening.
 *
 * - The Handsfree-owned job — never a manual one — is cancelled through the
 *   existing ProcessingJob mechanism while it still can be: its listeners
 *   abort the Whisper decode and LLM generation, and every later step
 *   discards its result (no transcript routed, no note, no answer).
 * - Once a note write has committed (`job.commit()`, just before the write)
 *   the job can't be cancelled; the note stays saved. An answer already in
 *   the chat history stays there.
 * - Either way the job is marked interrupted, so nothing more is spoken for
 *   it — not even "Saved." — and speech Handsfree is playing stops now.
 */
export type HandsfreeInterruptResult = {
  /** The job was cancelled (no further work, nothing more saved). */
  cancelled: boolean;
  /** The job had passed its point of no return: its note write proceeds. */
  committed: boolean;
};

export function interruptHandsfreeWork(deps: {
  /** The job of the Handsfree utterance in flight, if any. */
  handsfreeJob: ProcessingJob | null;
  interrupted: WeakSet<ProcessingJob>;
  /** Handsfree is speaking right now (its controller's state). */
  isSpeaking: boolean;
  stopSpeech: () => void;
  /** The cancelled job owned the screen: return it to idle. */
  onCancelled?: (job: ProcessingJob) => void;
}): HandsfreeInterruptResult {
  const { handsfreeJob: job } = deps;
  let cancelled = false;
  let committed = false;
  if (job) {
    deps.interrupted.add(job);
    cancelled = job.cancel();
    committed = job.committed;
    if (cancelled) deps.onCancelled?.(job);
  }
  if (deps.isSpeaking) deps.stopSpeech();
  return { cancelled, committed };
}

/** Whether a Handsfree utterance may still speak its result. */
export function mayHandsfreeSpeak(job: ProcessingJob, interrupted: WeakSet<ProcessingJob>): boolean {
  return !job.cancelled && !interrupted.has(job);
}
