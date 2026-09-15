/**
 * Build 42 P1-1c fix (qa/07-phase2-execution-brief.md): a tiny module-level
 * signal so playback call sites (`AudioPlayerControls`, `useChatSession`'s
 * `toggleSpeech`) can check "is the mic currently in use" without needing
 * `recorder.ts`'s/`activeMode.ts`'s React state prop-drilled down through
 * every screen that might render a play button — `NoteCard`/`NoteDetailModal`
 * render deep inside sheet/list components that have no natural access to
 * the Home screen's own `recorder`/`activeMode` hook instances. Mirrors the
 * same module-level-signal pattern already used by
 * `services/ai/localWhisper.ts`'s `activeTranscriptionCount` and
 * `services/ai/pipelineStage.ts`.
 *
 * Confirmed gap this closes: tapping "Listen"/a note's play button while a
 * manual recording or Handsfree session is active fed that audio straight
 * into the still-open mic with no echo cancellation — the exact hazard one
 * of the wake-word chain's fixes was built to prevent, but reachable through
 * this UI path because it was never covered by that fix's own scope.
 */
let micInUse = false;

export function setMicInUse(inUse: boolean): void {
  micInUse = inUse;
}

export function isMicInUse(): boolean {
  return micInUse;
}
