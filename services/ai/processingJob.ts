/**
 * One unit of user-visible processing — a voice utterance (or typed
 * submission) from "Got it" until its note is saved or its answer is ready.
 *
 * Cancel is split in two (see app/index.tsx's handleCancelProcessing):
 *   A. The UI acknowledges synchronously on tap — the job is marked
 *      cancelled and the screen returns to idle at once.
 *   B. The work underneath is then stopped where it genuinely can be
 *      (listeners registered with `onCancel`: Whisper's native abort, the
 *      LLM's stopCompletion), and everything else checks `cancelled` and
 *      discards its result — no note, no answer, no speech, no stale UI.
 *
 * Scoped per job: cancelling one job can never cancel a later one.
 */
export class ProcessingJob {
  private static nextId = 1;
  readonly id = ProcessingJob.nextId++;
  private _cancelled = false;
  private _committed = false;
  private readonly cancelListeners: (() => void)[] = [];

  get cancelled(): boolean {
    return this._cancelled;
  }

  get committed(): boolean {
    return this._committed;
  }

  /**
   * Cancels the job. Returns false if it was already cancelled or has
   * passed its point of no return (`commit`). Listeners run synchronously
   * but must only START async aborts — never block the caller.
   */
  cancel(): boolean {
    if (this._cancelled || this._committed) return false;
    this._cancelled = true;
    for (const listener of this.cancelListeners.splice(0)) {
      try {
        listener();
      } catch (err) {
        console.warn("[ProcessingJob] cancel listener failed", err);
      }
    }
    return true;
  }

  /**
   * Marks the point of no return (e.g. a note write about to begin): from
   * here Cancel no longer applies, so the UI must stop offering it. Returns
   * false if the job was already cancelled — the caller must not proceed.
   */
  commit(): boolean {
    if (this._cancelled) return false;
    this._committed = true;
    return true;
  }

  /** Runs `listener` on cancel (immediately if already cancelled). */
  onCancel(listener: () => void): void {
    if (this._cancelled) {
      listener();
      return;
    }
    if (!this._committed) this.cancelListeners.push(listener);
  }
}

/** Lets a job-scoped async step ask "should I still act on my result?". */
export type CancelCheck = () => boolean;
