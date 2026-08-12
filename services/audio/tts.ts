import * as Speech from "expo-speech";

/**
 * Strips Markdown formatting and citation chips out of RAG chat responses
 * so text-to-speech reads naturally instead of reciting punctuation
 * ("asterisk asterisk", "hashtag", "bracket Note 1 bracket", ...).
 */
export function sanitizeTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\[Note\s+\d+\]/gi, "") // citation chips, e.g. "[Note 1]"
    .replace(/^#{1,6}\s+/gm, "") // markdown headers
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1") // _italic_
    .replace(/#/g, "") // any remaining stray hashes
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Speaks `text` after sanitizing it, first stopping any speech already in
 * progress — like the single-instance audio player, only one utterance
 * should ever be audible at a time. No-ops on empty/whitespace-only input.
 */
export async function speakText(text: string, options?: Speech.SpeechOptions): Promise<void> {
  const sanitized = sanitizeTextForSpeech(text);
  if (!sanitized) {
    return;
  }

  await stopSpeech();

  try {
    Speech.speak(sanitized, options);
  } catch (err) {
    options?.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Stops any in-progress speech. Safe to call even when nothing is
 * speaking. Callers elsewhere in the app (recorder, audio player) call
 * this before starting a new recording or note playback so TTS never
 * overlaps with another audio source.
 */
export async function stopSpeech(): Promise<void> {
  try {
    await Speech.stop();
  } catch {
    // Nothing meaningful to recover into — already-stopped is fine.
  }
}
