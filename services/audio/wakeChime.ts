import { createAudioPlayer, type AudioPlayer } from "expo-audio";

/**
 * A short "wake word acknowledged" chime, played the moment Handsfree
 * confirms a Handsfree utterance contained the wake word (see
 * containsWakeWord's own doc comment in activeMode.ts, and its call site in
 * app/index.tsx) — NOT a live "now listening" cue. This app's wake-word
 * detection is transcript-based, not acoustic: it only knows the wake word
 * was said once the WHOLE utterance has already been recorded and
 * transcribed (see activeMode.ts's Build 24/25 comments). A chime here is
 * therefore a "your command was heard and is being acted on" confirmation,
 * not the "I'm listening now, go ahead" cue a real acoustic wake-word engine
 * (Porcupine or similar — still blocked on licensing, same file) would give
 * BEFORE the command. Worth knowing before tuning this further: it cannot be
 * moved earlier without a real acoustic wake-word engine underneath it.
 *
 * Deliberately a SEPARATE player instance from services/audio/player.ts's
 * shared one — that module is scoped to playing a user's saved note
 * recordings (one track at a time, tied to playback-UI state a note card
 * reads), and `playUri()` there explicitly stops any in-progress TTS as a
 * side effect. Routing a short UI chime through it would steal that shared
 * player away from whatever note might be playing and would make an
 * unrelated note card's "is this playing" UI flicker. A chime is a distinct,
 * fire-and-forget UI sound, not app audio content.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const WAKE_CHIME_ASSET = require("../../assets/sounds/wake_chime.wav");

let chimePlayer: AudioPlayer | null = null;

/**
 * Loads the chime asset into its own native player ahead of time, so the
 * first real wake-word detection doesn't pay a load delay before the sound
 * is audible. Called once when Handsfree engages (see activeMode.ts's
 * `start()`) — idempotent, safe to call again on every engagement.
 */
export function preloadWakeChime(): void {
  if (chimePlayer) {
    return;
  }
  if (typeof createAudioPlayer !== "function") {
    // Mirrors the guard in player.ts's ensurePlayer() -- a stale dev-client
    // build otherwise surfaces this as an opaque native error much later,
    // on first playback attempt, instead of here.
    console.warn("[WakeChime] expo-audio: createAudioPlayer unavailable — chime disabled for this session.");
    return;
  }
  try {
    chimePlayer = createAudioPlayer(WAKE_CHIME_ASSET);
  } catch (err) {
    console.warn("[WakeChime] Failed to preload chime asset:", err);
    chimePlayer = null;
  }
}

/**
 * Plays the chime from the start. Fire-and-forget by design (matches how
 * every call site uses it — nothing awaits this or needs to know when the
 * chime finishes); a failure here should never block or fail the utterance
 * it's confirming.
 */
export function playWakeChime(): void {
  if (!chimePlayer) {
    preloadWakeChime();
  }
  try {
    chimePlayer?.seekTo(0);
    chimePlayer?.play();
  } catch (err) {
    console.warn("[WakeChime] Failed to play chime:", err);
  }
}

/** Releases the dedicated chime player. Mirrors player.ts's releasePlayer —
 * called when Handsfree fully stops, so the native resource doesn't sit
 * loaded for the rest of the app session on the (common) path where
 * Handsfree is only used occasionally. */
export function releaseWakeChime(): void {
  try {
    chimePlayer?.remove();
  } catch {
    // Already-detached native object — nothing to do.
  }
  chimePlayer = null;
}
