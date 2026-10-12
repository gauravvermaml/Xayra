import { AskProgress } from "./pipelineStage";
import type { PendingAsk } from "./useChatSession";

/**
 * A manual voice Ask between "recording ended" and "question routed": the
 * tray's reserved answer bubble and the progress that owns its first line
 * ("Got it…" / "Turning that into text…"). Created at capture end; handed
 * to chatSession.ask() once transcription returns, or discarded.
 */
export type VoiceAskReservation = { pending: PendingAsk; progress: AskProgress };

/**
 * At the moment a manual recording ends: for an Ask, reserve its answer
 * bubble, start its transcription progress and raise the tray — once, so
 * the tray is the single surface for the whole Ask wait. Record (or any
 * other mode) gets nothing: its status stays under the central button.
 */
export function reserveVoiceAsk(
  mode: "record" | "ask",
  deps: { beginPendingAsk: () => PendingAsk; raiseTray: () => void }
): VoiceAskReservation | null {
  if (mode !== "ask") return null;
  const progress = new AskProgress();
  const pending = deps.beginPendingAsk();
  progress.transcribing();
  deps.raiseTray();
  return { pending, progress };
}

/** Undo a reservation that never became a question. Safe to call after
 * ask() took it over (the bubble is then kept, and the progress has already
 * been superseded by the request's own). */
export function discardVoiceAskReservation(
  reservation: VoiceAskReservation,
  discardPendingAsk: (pending: PendingAsk) => void
): void {
  reservation.progress.end();
  discardPendingAsk(reservation.pending);
}
