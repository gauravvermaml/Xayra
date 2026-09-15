/**
 * A tiny shared pub/sub so the UI can show what's ACTUALLY happening during
 * a note save or a query — "Hearing you out", "Finding where this belongs",
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
  | "transcribing" // Whisper turning speech into text
  | "understanding" // the embedding model placing a note in semantic space
  | "saving" // the encrypted write finishing
  | "retrieving" // hybrid vector+keyword search for a query
  | "answering"; // the LLM composing an answer, before its first token streams in

type Listener = (stage: PipelineStage | null) => void;

const listenersByFlow: Record<PipelineFlow, Set<Listener>> = {
  note: new Set(),
  chat: new Set(),
};

const currentByFlow: Record<PipelineFlow, PipelineStage | null> = {
  note: null,
  chat: null,
};

export function setPipelineStage(flow: PipelineFlow, stage: PipelineStage | null): void {
  currentByFlow[flow] = stage;
  listenersByFlow[flow].forEach((listener) => listener(stage));
}

export function getPipelineStage(flow: PipelineFlow): PipelineStage | null {
  return currentByFlow[flow];
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
  transcribing: "Hearing you out",
  understanding: "Finding where this belongs",
  saving: "Tucked away safely",
  retrieving: "Reading through your notes",
  answering: "Piecing it together",
};
