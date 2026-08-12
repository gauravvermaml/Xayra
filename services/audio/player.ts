import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import * as FileSystem from "expo-file-system/legacy";
import { createAudioPlayer, type AudioPlayer, type AudioStatus } from "expo-audio";

import { stopSpeech } from "./tts";

export type PlaybackState = {
  /** URI of the track the shared player is currently loaded with (or was last asked to load). */
  activeUri: string | null;
  isPlaying: boolean;
  isLoaded: boolean;
  currentTime: number;
  duration: number;
  /** Set when `activeUri` failed to load/play; cleared on the next successful `playUri`. */
  error: string | null;
};

const INITIAL_STATE: PlaybackState = {
  activeUri: null,
  isPlaying: false,
  isLoaded: false,
  currentTime: 0,
  duration: 0,
  error: null,
};

/**
 * Exactly one native `AudioPlayer` exists for the whole app (module-scoped,
 * not per-component) — that's what makes playback single-instance: starting
 * a new track always reuses/replaces this same player instead of creating a
 * second concurrent one, so at most one track can ever be audible.
 */
let player: AudioPlayer | null = null;
let statusSubscription: { remove: () => void } | null = null;
let state: PlaybackState = INITIAL_STATE;
let mountedConsumerCount = 0;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function setState(patch: Partial<PlaybackState>): void {
  state = { ...state, ...patch };
  notify();
}

function getSnapshot(): PlaybackState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to play audio.";
}

function attachStatusListener(instance: AudioPlayer): void {
  statusSubscription?.remove();
  statusSubscription = instance.addListener("playbackStatusUpdate", (status: AudioStatus) => {
    setState({
      isPlaying: status.playing,
      isLoaded: status.isLoaded,
      currentTime: status.currentTime,
      duration: status.duration,
    });
  });
}

function ensurePlayer(): AudioPlayer {
  if (player) {
    return player;
  }
  if (typeof createAudioPlayer !== "function") {
    // Mirrors the guard pattern in services/audio/recorder.ts: a mismatched
    // native dev-client build otherwise surfaces this as an opaque
    // "undefined is not a function" instead of a readable message.
    throw new Error(
      "expo-audio: createAudioPlayer is not available on this build. The native dev client is likely out of date — rebuild it."
    );
  }
  player = createAudioPlayer(null);
  return player;
}

/**
 * Loads and plays `uri`, first pausing whatever was previously active — see
 * the module-level comment on `player` for why there's only ever one track
 * audible at a time. Missing/inaccessible files and native playback
 * failures are caught and surfaced via `state.error` rather than throwing.
 */
export async function playUri(uri: string): Promise<void> {
  // A note recording and TTS narration should never be audible at once.
  void stopSpeech();

  if (typeof FileSystem.getInfoAsync === "function") {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) {
        setState({
          activeUri: uri,
          isPlaying: false,
          isLoaded: false,
          currentTime: 0,
          duration: 0,
          error: "Audio file not found. It may have been deleted.",
        });
        return;
      }
    } catch {
      // Existence check itself failed (e.g. on a platform/build where
      // getInfoAsync misbehaves) — fall through and let the player's own
      // try/catch below be the real guard instead of blocking playback.
    }
  }

  let instance: AudioPlayer;
  try {
    instance = ensurePlayer();
  } catch (err) {
    setState({ activeUri: uri, error: describeError(err) });
    return;
  }

  if (state.activeUri === uri && state.isLoaded) {
    try {
      instance.play();
    } catch (err) {
      setState({ error: describeError(err) });
    }
    return;
  }

  if (state.isPlaying) {
    try {
      instance.pause();
    } catch {
      // Best-effort — proceeding to load the new track either way.
    }
  }

  setState({
    activeUri: uri,
    isPlaying: false,
    isLoaded: false,
    currentTime: 0,
    duration: 0,
    error: null,
  });
  attachStatusListener(instance);

  try {
    instance.replace(uri);
    instance.play();
  } catch (err) {
    setState({ error: describeError(err) });
  }
}

export function pausePlayback(): void {
  try {
    player?.pause();
  } catch {
    // Nothing meaningful to recover into; pausing a dead player is a no-op.
  }
}

export function seekToPlayback(seconds: number): void {
  if (!player) {
    return;
  }
  void player.seekTo(seconds).catch(() => {
    // Seeking past the end / on a not-yet-loaded player — ignore.
  });
}

/**
 * Fully tears down the shared native player. Safe to call any time (e.g.
 * with nothing loaded); `useAudioPlayerControls` calls this automatically
 * once the last mounted consumer of the shared player unmounts.
 */
export function releasePlayer(): void {
  statusSubscription?.remove();
  statusSubscription = null;
  try {
    player?.remove();
  } catch {
    // Already-detached native object — nothing to do.
  }
  player = null;
  state = INITIAL_STATE;
  notify();
}

export type UseAudioPlayerControls = {
  isActive: boolean;
  isPlaying: boolean;
  isLoaded: boolean;
  currentTime: number;
  duration: number;
  error: string | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (seconds: number) => void;
};

/**
 * Scopes the single shared player's state to whether `uri` is the track
 * it's currently loaded with, so a different track playing elsewhere in the
 * app doesn't make this instance's UI think it's the one playing.
 */
export function useAudioPlayerControls(uri: string): UseAudioPlayerControls {
  const globalState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isActive = globalState.activeUri === uri;

  const uriRef = useRef(uri);
  uriRef.current = uri;

  // Reference-counts mounted consumers of the shared player so the native
  // resource is released once nothing on screen could possibly need it,
  // without one card's unmount tearing down playback for a sibling card
  // that's still actively using it.
  useEffect(() => {
    mountedConsumerCount += 1;
    return () => {
      mountedConsumerCount = Math.max(0, mountedConsumerCount - 1);
      if (getSnapshot().activeUri === uriRef.current) {
        pausePlayback();
      }
      if (mountedConsumerCount === 0) {
        releasePlayer();
      }
    };
  }, []);

  const play = useCallback(() => {
    void playUri(uri);
  }, [uri]);

  const pause = useCallback(() => {
    if (isActive) {
      pausePlayback();
    }
  }, [isActive]);

  const toggle = useCallback(() => {
    if (isActive && globalState.isPlaying) {
      pausePlayback();
    } else {
      void playUri(uri);
    }
  }, [isActive, globalState.isPlaying, uri]);

  const seek = useCallback(
    (seconds: number) => {
      if (isActive) {
        seekToPlayback(seconds);
      }
    },
    [isActive]
  );

  return {
    isActive,
    isPlaying: isActive && globalState.isPlaying,
    isLoaded: isActive && globalState.isLoaded,
    currentTime: isActive ? globalState.currentTime : 0,
    duration: isActive ? globalState.duration : 0,
    error: isActive ? globalState.error : null,
    play,
    pause,
    toggle,
    seek,
  };
}
