/**
 * A tiny shared pub/sub so the UI can show what's ACTUALLY happening during
 * a note save or a query — "Got it", "Finding where this belongs",
 * "Reading through your notes" — instead of one static "Transcribing..." /
 * "Thinking..." label (or a bare spinner) that says nothing about real
 * progress. Same shape as `services/notifications/todoNotifications.ts`'s
 * own tap-to-open pub/sub: a low-level service (here, `noteManager.ts`,
 * `rag.ts`) reports its own real milestones without needing to import any
 * UI code, and any screen — `app/index.tsx`'s recorder canvas AND
 * `ChatSheetContent.tsx`'s streaming-answer row both do, independently —
 * can subscribe to the same single source of truth rather than keeping two
 * separately-hardcoded copies of "what's happening right now" that could
 * silently drift out of sync with each other.
 *
 * Deliberately reflects REAL pipeline milestones, not a fixed cosmetic
 * timer (unlike OnboardingSetupScreen.tsx's one deliberately-cosmetic
 * step) — a stage is set exactly when its real underlying work starts, so
 * it lingers exactly as long as that work actually takes on this device,
 * never longer and never faked.
 *
 * QA Phase 3, P2-2 fix: this used to be ONE shared `current` value for the
 * whole app, so a note save (`noteManager.ts`) and a chat query (`rag.ts`)
 * running back-to-back — e.g. asking a question while an earlier recording
 * is still being embedded — could each overwrite the other's label, and
 * whichever screen re-rendered next would show the WRONG flow's status.
 * Keyed by `PipelineFlow` now so the two flows can never step on each
 * other: `noteManager.ts` only ever writes/reads `"note"`,
 * `rag.ts`/`ChatSheetContent.tsx` only ever write/read `"chat"`. No
 * behavior change for the (overwhelmingly common) single-flow-at-a-time
 * case — this only changes what happens when both are genuinely
 * in-flight at once, which had no known live symptom before this fix.
 */
export type PipelineFlow = "note" | "chat";

export type PipelineStage =
  | "transcribing" // Whisper turning speech into text (capture has already ended)
  | "understanding" // the embedding model placing a note in semantic space
  | "saving" // the encrypted write finishing
  | "retrieving" // looking for the notes a question is about
  | "answering"; // the model producing an answer (hidden until validated)

/** Listeners get the stage plus the exact words to show for it (the stage
 * label, a count-specific evidence line, or the current inference phrase). */
type Listener = (stage: PipelineStage | null, label: string | null) => void;

type FlowState = { stage: PipelineStage | null; label: string | null; owner: object | null };

const listenersByFlow: Record<PipelineFlow, Set<Listener>> = {
  note: new Set(),
  chat: new Set(),
};

const stateByFlow: Record<PipelineFlow, FlowState> = {
  note: { stage: null, label: null, owner: null },
  chat: { stage: null, label: null, owner: null },
};

/**
 * Sets a flow's stage. `label` overrides the stage's default words; `owner`
 * marks who set it, so an owner can later clear only its own stage (see
 * AskProgress) — an unowned write (owner null) is never clearable by a
 * stale owner.
 */
export function setPipelineStage(
  flow: PipelineFlow,
  stage: PipelineStage | null,
  options?: { label?: string; owner?: object }
): void {
  const label = stage ? (options?.label ?? PIPELINE_STAGE_LABELS[stage]) : null;
  stateByFlow[flow] = { stage, label, owner: stage ? (options?.owner ?? null) : null };
  listenersByFlow[flow].forEach((listener) => listener(stage, label));
}

/** Clears the flow only if `owner` still owns its current stage. */
function clearPipelineStageIfOwner(flow: PipelineFlow, owner: object): void {
  if (stateByFlow[flow].owner === owner) setPipelineStage(flow, null);
}

export function getPipelineStage(flow: PipelineFlow): PipelineStage | null {
  return stateByFlow[flow].stage;
}

/** The words currently shown for a flow's stage (null when idle). */
export function getPipelineStageLabel(flow: PipelineFlow): string | null {
  return stateByFlow[flow].label;
}

/** Returns an unsubscribe function — call it on unmount. */
export function subscribeToPipelineStage(flow: PipelineFlow, listener: Listener): () => void {
  listenersByFlow[flow].add(listener);
  return () => {
    listenersByFlow[flow].delete(listener);
  };
}

/** Shared so every screen renders the same words for the same stage —
 * kept here rather than duplicated per-screen for the same "don't let two
 * copies drift" reason the pub/sub above exists. Deliberately generic,
 * product-voice copy: no model names, no technical terms, matches the tone
 * `localLlama.ts`'s own SYSTEM_PROMPT sets for Xayra elsewhere. */
export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  // Transcription only ever starts once the user has stopped talking, so
  // this acknowledges what was heard rather than implying Xayra is still
  // listening (it used to read "Hearing you out").
  transcribing: "Got it",
  understanding: "Finding where this belongs",
  saving: "Tucked away safely",
  retrieving: "Looking through your memories…",
  answering: "Piecing it together…",
};

/**
 * The evidence line for the final notes an answer will be built from (the
 * notes after buildNoteContext — exactly what the model is shown). Says
 * "related", not "relevant": validation may still reject the answer ("I found
 * related notes, but couldn't verify…"). Null when no notes remain.
 */
export function evidenceLabel(includedNotes: number): string | null {
  if (includedNotes <= 0) return null;
  return includedNotes === 1 ? "Found a related memory" : `Found ${includedNotes} related memories`;
}

/**
 * Wording while the model genuinely hasn't produced a usable answer yet.
 * These are alternate descriptions of that ONE state — not milestones: a
 * phrase change never means a backend step finished. Times are from when
 * answering began; product-tuning values, to be revisited with Pixel 9 vs
 * Redmi dogfood timings. (No "Almost there": nothing signals that.) The
 * first phrase carries the evidence count (see AskProgress.answering).
 */
export const ASK_INFERENCE_PHRASES: readonly { afterMs: number; label: string }[] = [
  { afterMs: 0, label: "Piecing it together…" },
  { afterMs: 3000, label: "Connecting the dots…" },
  { afterMs: 8000, label: "Working through your memories…" },
];

/**
 * The first answering line: the evidence count and the first inference
 * phrase together. Inference starts within milliseconds of the evidence
 * being known, so a separate count line would never be seen — and holding
 * it artificially would delay nothing real but would be theatre. Both facts
 * are already true when this shows.
 */
export function firstAnsweringLabel(includedNotes: number): string {
  const evidence = evidenceLabel(includedNotes);
  const first = ASK_INFERENCE_PHRASES[0].label;
  return evidence ? `${evidence} · ${first}` : first;
}

let activeAsk: AskProgress | null = null;

/**
 * Owns the chat flow's progress for ONE Ask, from retrieval to its answer,
 * fallback, error or cancel. Created by the RAG exchange itself, so the
 * lifecycle never depends on how many screens are watching — UI only
 * observes via subscribeToPipelineStage.
 *
 * - A newer Ask supersedes this one at once (its timers stop; it can no
 *   longer write or clear the stage).
 * - Cancelling its job ends it immediately (signal.onCancel), and every
 *   write re-checks it, so a cancelled job never updates progress.
 * - `end()` clears the stage only if this Ask still owns it.
 * - The inference phrases are a short setTimeout chain (one timer per
 *   phrase change), never an interval.
 */
export class AskProgress {
  private ended = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private includedNotes = 0;

  constructor(private readonly signal?: { readonly cancelled: boolean; onCancel(fn: () => void): void }) {
    activeAsk?.supersede();
    activeAsk = this;
    signal?.onCancel(() => this.end());
  }

  /** Retrieval has started. */
  retrieving(): void {
    this.publish("retrieving");
  }

  /** The final notes are known; shown with the first inference phrase. */
  evidence(includedNotes: number): void {
    this.includedNotes = includedNotes;
  }

  /** The model has started producing the answer. */
  answering(): void {
    if (!this.isLive()) return;
    this.clearTimers();
    const [first, ...later] = ASK_INFERENCE_PHRASES;
    this.publish("answering", firstAnsweringLabel(this.includedNotes));
    for (const phrase of later) {
      this.timers.push(setTimeout(() => this.publish("answering", phrase.label), phrase.afterMs - first.afterMs));
    }
  }

  /** Answer, fallback, error or cancel: stop now and clear our stage. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    if (activeAsk === this) activeAsk = null;
    clearPipelineStageIfOwner("chat", this);
  }

  private supersede(): void {
    this.ended = true;
    this.clearTimers();
  }

  private isLive(): boolean {
    if (this.ended) return false;
    if (this.signal?.cancelled) {
      this.end();
      return false;
    }
    return true;
  }

  private publish(stage: PipelineStage, label?: string): void {
    if (!this.isLive()) return;
    setPipelineStage("chat", stage, { label, owner: this });
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}
