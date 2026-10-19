/** The message for a manual Cancel whose microphone stop failed (Stage 5a). */
export const CANCEL_STOP_FAILED_MESSAGE = "Couldn’t stop the microphone. Try Cancel again.";

/**
 * After a retried Cancel succeeds, its own earlier "couldn't stop" message no
 * longer applies (Gate B). Any other error — another recording's, or a
 * genuine failure — is returned unchanged.
 */
export function clearCancelStopError(current: string | null): string | null {
  return current === CANCEL_STOP_FAILED_MESSAGE ? null : current;
}
