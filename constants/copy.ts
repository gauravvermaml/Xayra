/**
 * Consumer-facing copy that has to stay coherent across screens and with
 * the selected Record/Ask mode. Kept in one place so the home screen,
 * Archive and their tests can't drift apart.
 */
import type { UtteranceMode } from "../services/audio/manualUtterance";

/** Home subtitle under the brand (after the launch greeting fades). */
export const HOME_SUBTITLE: Record<UtteranceMode, string> = {
  record: "Speak or type a thought. Say “remind me…” to create a to-do.",
  ask: "Ask Xayra about anything you’ve recorded.",
};

/** What a tap on the central button will do, shown only while idle. */
export const IDLE_TAP_CUE: Record<UtteranceMode, string> = {
  record: "Tap to record",
  ask: "Tap to ask",
};

/** Ask's empty-state suggestions. Ask answers from recorded notes — not
 * the live To-Do list — so none of these may promise otherwise. */
export const ASK_STARTER_PROMPTS = [
  "Summarize my latest notes",
  "What did I record about work?",
  "What reminders have I recorded recently?",
] as const;

export const NOTES_EMPTY_TITLE = "No notes recorded yet.";
/** Home Record tray: the compose bar sits directly below this. */
export const RECORD_EMPTY_SUBTEXT = "Tap Xayra to speak, or type your first thought below.";
/** Archive has no compose bar or Xayra button of its own. */
export const ARCHIVE_EMPTY_SUBTEXT = "Tap Xayra on the home screen to speak or type your first thought.";
/** Voice before the offline speech model is installed (onboarding can be
 * finished early): nothing is recorded, so no spoken note is lost. */
export const VOICE_MODEL_NOT_READY =
  "Voice needs Xayra's speech model, which is still downloading. You can type a note or a question meanwhile.";
/** Onboarding's early way in, when the speech model isn't installed yet. */
export const SETUP_VOICE_PENDING_HINT =
  "Typing works now; voice will be ready once its speech model finishes downloading.";
