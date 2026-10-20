/**
 * Android Back on the home screen (Xayra 2.0 Stages 5c–5d): the topmost
 * thing the user opened closes first, then a raised tray settles to rest,
 * and only the resting home screen hands Back to the system.
 *
 * Not listed because Android routes Back to them before any JS listener:
 * the keyboard (the IME consumes the first Back; the field keeps focus and
 * the draft) and native `<Modal>`s such as NoteDetailModal (their
 * `onRequestClose`).
 */
export type HomeBackState = {
  /** The More menu (Archived notes / Settings) is open. */
  quickMenuOpen: boolean;
  /** The To-Dos overlay is open. */
  todosOpen: boolean;
  /** The full-screen reading view is open. */
  fullScreenOpen: boolean;
  /** The compose field still has focus (keyboard already dismissed). */
  composing: boolean;
  /** The tray is at its 50% stage (or still settling from it). */
  trayRaised: boolean;
};

export type HomeBackAction =
  | "close-quick-menu"
  /** To-Dos first closes its own topmost sheet; if none is open, To-Dos
   * itself closes. */
  | "todos"
  | "collapse-full-screen"
  /** Leave the field (blur) — the draft stays. */
  | "end-composing"
  /** 50% tray: settle to the measured resting stage (Stage 5d). Mode,
   * history and draft are untouched. */
  | "collapse-tray"
  /** Nothing open: Android's own Back (Xayra goes to the background). */
  | "system";

export function decideHomeBack(state: HomeBackState): HomeBackAction {
  if (state.quickMenuOpen) return "close-quick-menu";
  if (state.todosOpen) return "todos";
  if (state.fullScreenOpen) return "collapse-full-screen";
  if (state.composing) return "end-composing";
  if (state.trayRaised) return "collapse-tray";
  return "system";
}
