import { Buffer } from "buffer";
import AudioRecord, {
  type AudioPcmStreamOptions,
  type MicSessionReleasedEvent,
  type MicSessionStatusResult,
} from "@fugood/react-native-audio-pcm-stream";

import { devTiming } from "../ai/perf";

/**
 * The app's one owner of the native microphone session (microphone
 * reliability Gate B, over Gate A's native session API in
 * patches/@fugood+react-native-audio-pcm-stream+1.1.4.patch).
 *
 * Manual Record/Ask (recorder.ts) and Handsfree (activeMode.ts) open and
 * stop capture only through here, and "is the microphone in use"
 * (audioInputState.isMicInUse) is derived from it. The microphone counts as
 * free only after the native side confirms the recorder was released — a
 * successful stop request, a returned promise or an elapsed delay never
 * does. While release is unconfirmed or failed, nothing new may open.
 *
 * Every native event carries its session id; anything for a session other
 * than the one tracked here is ignored, so a late chunk or acknowledgement
 * from an older recording can never touch a newer one. Audio chunks carry
 * a sequence number and the release acknowledgement the last one, so a
 * recording's completeness is checked by count.
 */

export type MicOwner = "manual" | "handsfree";

export type MicPhase =
  /** Released (or never opened): free. */
  | "idle"
  /** A native session is being set up. */
  | "opening"
  | "capturing"
  /** Stop requested; waiting for the native release acknowledgement. */
  | "releasing"
  /** The native stop request itself failed: still capturing. */
  | "stopFailed"
  /** No confirmation even after a forced stop; re-checked periodically. */
  | "releaseUnconfirmed"
  /** The native release threw: the recorder is in an unknown state until
   * the app restarts. */
  | "releaseFailed";

export type MicSnapshot = { phase: MicPhase; owner: MicOwner | null; sessionId: number | null };

/** Wait for the acknowledgement before asking the native side directly. */
export const RELEASE_ACK_TIMEOUT_MS = 2000;
/** After a forced stop, wait this long before asking again. */
export const FORCE_RELEASE_WAIT_MS = 1000;
/** While unconfirmed, how often the native state is re-checked. */
export const UNCONFIRMED_POLL_MS = 5000;
/** After release, how long chunks already emitted may take to arrive. */
export const DRAIN_TIMEOUT_MS = 500;

export class MicBusyError extends Error {
  readonly phase: MicPhase;
  constructor(phase: MicPhase) {
    super(busyMessage(phase));
    this.name = "MicBusyError";
    this.phase = phase;
  }
}

/** What the microphone state means for the person using the app. */
export function busyMessage(phase: MicPhase): string {
  switch (phase) {
    case "releaseFailed":
      return "Xayra couldn’t close the microphone. Close and reopen Xayra.";
    case "releaseUnconfirmed":
    case "releasing":
      return "The microphone is still closing. Try again in a moment.";
    case "stopFailed":
      return "Couldn’t stop the microphone. Try again.";
    default:
      return "The microphone is already in use.";
  }
}

export type CaptureHandlers = {
  /** Each audio chunk while capturing (base64 PCM, in arrival order). */
  onChunk?: (base64: string) => void;
  onError?: (message: string) => void;
};

export type OpenOptions = {
  /** Keep every chunk for `stop()` to return (manual recording). Handsfree
   * buffers its own utterances and passes false. */
  collect: boolean;
};

export type CapturedAudio = {
  /** In sequence order, never mixed with another session's. */
  chunks: Buffer[];
  /** The native count of chunks emitted; null when release wasn't
   * confirmed, so completeness can't be known. */
  lastSeq: number | null;
  missing: number[];
  /** True only when release was confirmed and every chunk 1..lastSeq
   * arrived exactly once. */
  complete: boolean;
  /** The final chunk(s) are among the missing. */
  tailMissing: boolean;
};

export type StopResult =
  | { kind: "released"; audio: CapturedAudio | null }
  /** The stop request failed; the session is still capturing. */
  | { kind: "stopFailed"; error: unknown }
  | { kind: "releaseUnconfirmed"; audio: CapturedAudio | null }
  | { kind: "releaseFailed"; audio: CapturedAudio | null };

type Tracked = {
  id: number;
  owner: MicOwner;
  collect: boolean;
  handlers: CaptureHandlers;
  chunks: Map<number, string>;
  release: MicSessionReleasedEvent | null;
  /** lastSeq learned from a status query when the event was lost. */
  statusLastSeq: number | null;
  waiters: Array<() => void>;
  /** Audio handed back: later chunks are ignored. */
  finalized: boolean;
  /** One confirmation per session, shared by concurrent stops. */
  confirming: Promise<"released" | "releaseUnconfirmed" | "releaseFailed"> | null;
  /** A stop was requested (possibly while still opening). */
  stopRequested: boolean;
  /** The native stop request in flight: concurrent stops join it. */
  stopRequest: Promise<unknown> | null;
};

let phase: MicPhase = "idle";
let current: Tracked | null = null;
let openingOwner: MicOwner | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;
const listeners = new Set<(snapshot: MicSnapshot) => void>();
const phaseWaiters: Array<() => void> = [];

/** Read through a call so TypeScript doesn't narrow it across awaits. */
function getPhase(): MicPhase {
  return phase;
}

export function getMicSnapshot(): MicSnapshot {
  return { phase, owner: current?.owner ?? openingOwner, sessionId: current?.id ?? null };
}

/** Anything but idle: the microphone is, or may still be, in use. */
export function isMicSessionBusy(): boolean {
  return phase !== "idle";
}

export function subscribeMicState(listener: (snapshot: MicSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setPhase(next: MicPhase): void {
  if (phase === next) return;
  phase = next;
  const snapshot = getMicSnapshot();
  devTiming("MicSession", `phase ${next}`, { sessionId: snapshot.sessionId ?? 0 });
  listeners.forEach((listener) => listener(snapshot));
  phaseWaiters.splice(0).forEach((resolve) => resolve());
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  AudioRecord.onSession("sessionData", (e) => {
    const t = current;
    if (!t || t.id !== e.sessionId || t.finalized) {
      devTiming("MicSession", "chunk ignored", { sessionId: e.sessionId, seq: e.seq });
      return;
    }
    if (t.collect) t.chunks.set(e.seq, e.data);
    if (phase === "capturing") t.handlers.onChunk?.(e.data);
  });
  AudioRecord.onSession("sessionReleased", (e) => {
    const t = current;
    if (!t || t.id !== e.sessionId) {
      devTiming("MicSession", "release ignored", { sessionId: e.sessionId });
      return;
    }
    if (!t.release) t.release = e;
    t.waiters.splice(0).forEach((resolve) => resolve());
  });
  AudioRecord.onSession("sessionError", (e) => {
    const t = current;
    if (t && t.id === e.sessionId) t.handlers.onError?.(e.message);
  });
  AudioRecord.onSession("sessionSilenced", (e) => {
    const t = current;
    // Diagnostic only (Gate A D7): no behaviour depends on it yet.
    if (t && t.id === e.sessionId && e.silenced) {
      devTiming("MicSession", "capture silenced", { sessionId: e.sessionId });
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForRelease(t: Tracked, timeoutMs: number): Promise<boolean> {
  if (t.release) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(t.release !== null), timeoutMs);
    t.waiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function waitForPhaseChange(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    phaseWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function nativeStatus(id: number): Promise<MicSessionStatusResult | null> {
  try {
    return await AudioRecord.sessionStatus(id);
  } catch {
    return null;
  }
}

/** Reads a terminal answer from a native status, if it has one. */
function terminalFromStatus(t: Tracked, status: MicSessionStatusResult | null): "released" | "releaseFailed" | null {
  if (!status) return null;
  if (status.status === "released" || status.status === "unknown") {
    // "unknown": no record of the session in this process — nothing of
    // ours can be holding the microphone under that id.
    t.statusLastSeq = status.lastSeq ?? null;
    return "released";
  }
  if (status.status === "releaseFailed") return "releaseFailed";
  return null;
}

function finishReleased(t: Tracked): void {
  stopPolling();
  if (current === t) current = null;
  setPhase("idle");
}

function stopPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** While unconfirmed: keep asking the native side until it answers. */
function startPolling(t: Tracked): void {
  stopPolling();
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (current !== t || getPhase() !== "releaseUnconfirmed") return;
    const outcome = t.release ? (t.release.ok ? "released" : "releaseFailed") : terminalFromStatus(t, await nativeStatus(t.id));
    if (current !== t || getPhase() !== "releaseUnconfirmed") return;
    if (outcome === "released") finishReleased(t);
    else if (outcome === "releaseFailed") setPhase("releaseFailed");
    else startPolling(t);
  }, UNCONFIRMED_POLL_MS);
}

/**
 * The acknowledgement, else the native status, else a forced stop and the
 * status again. Never concludes "released" from a timeout alone.
 */
function confirmRelease(t: Tracked): Promise<"released" | "releaseUnconfirmed" | "releaseFailed"> {
  if (!t.confirming) {
    t.confirming = (async () => {
      if (await waitForRelease(t, RELEASE_ACK_TIMEOUT_MS)) {
        return t.release?.ok === false ? "releaseFailed" : "released";
      }
      let outcome = terminalFromStatus(t, await nativeStatus(t.id));
      if (!outcome) {
        devTiming("MicSession", "release unacknowledged; forcing", { sessionId: t.id });
        try {
          await AudioRecord.forceRelease(t.id);
        } catch {
          // The status below decides.
        }
        if (await waitForRelease(t, FORCE_RELEASE_WAIT_MS)) {
          return t.release?.ok === false ? "releaseFailed" : "released";
        }
        outcome = terminalFromStatus(t, await nativeStatus(t.id));
      }
      return outcome ?? "releaseUnconfirmed";
    })().finally(() => {
      t.confirming = null;
    });
  }
  return t.confirming;
}

/** Waits (bounded) for every chunk up to lastSeq, then hands the audio
 * back in sequence order. */
async function drain(t: Tracked): Promise<CapturedAudio> {
  const lastSeq = t.release?.lastSeq ?? t.statusLastSeq;
  if (lastSeq !== null && t.chunks.size < lastSeq) {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (t.chunks.size < lastSeq && Date.now() < deadline) {
      await sleep(25);
    }
  }
  t.finalized = true;
  const seqs = [...t.chunks.keys()].sort((a, b) => a - b);
  const missing: number[] = [];
  if (lastSeq !== null) {
    for (let seq = 1; seq <= lastSeq; seq++) if (!t.chunks.has(seq)) missing.push(seq);
  }
  const audio: CapturedAudio = {
    chunks: seqs.map((seq) => Buffer.from(t.chunks.get(seq) as string, "base64")),
    lastSeq,
    missing,
    complete: lastSeq !== null && missing.length === 0 && seqs.every((seq) => seq <= lastSeq),
    tailMissing: lastSeq !== null && lastSeq > 0 && missing.includes(lastSeq),
  };
  t.chunks.clear();
  if (!audio.complete) {
    devTiming("MicSession", "audio incomplete", {
      sessionId: t.id,
      lastSeq: lastSeq ?? -1,
      missing: missing.length,
      tailMissing: audio.tailMissing,
    });
  }
  return audio;
}

/** A native owner this JS context didn't open (left by a torn-down React
 * instance): track it and close it like any other. */
async function adoptOrphan(): Promise<void> {
  const status = await nativeStatus(0);
  if (!status || status.status === "none" || current) return;
  const t: Tracked = {
    id: status.sessionId,
    owner: "manual",
    collect: false,
    handlers: {},
    chunks: new Map(),
    release: null,
    statusLastSeq: null,
    waiters: [],
    finalized: true,
    confirming: null,
    stopRequested: true,
    stopRequest: null,
  };
  current = t;
  setPhase("releasing");
  try {
    await AudioRecord.stopSession(t.id);
  } catch {
    // The confirmation below asks the native side directly.
  }
  void confirmRelease(t).then((outcome) => {
    if (current !== t) return;
    if (outcome === "released") finishReleased(t);
    else {
      setPhase(outcome);
      if (outcome === "releaseUnconfirmed") startPolling(t);
    }
  });
}

/**
 * Opens a capture session for `owner`. Waits briefly if the previous
 * session is still releasing; throws MicBusyError while the microphone is
 * (or may still be) in use. In "releaseUnconfirmed", a call re-checks
 * first — that is the user's retry.
 */
export async function openMicSession(
  owner: MicOwner,
  options: AudioPcmStreamOptions,
  handlers: CaptureHandlers,
  { collect }: OpenOptions
): Promise<number> {
  ensureSubscribed();
  if (phase === "releasing") {
    await waitForPhaseChange(RELEASE_ACK_TIMEOUT_MS + FORCE_RELEASE_WAIT_MS + 1000);
  }
  if (getPhase() === "releaseUnconfirmed") {
    await retryMicRelease();
  }
  if (getPhase() !== "idle") {
    throw new MicBusyError(getPhase());
  }
  openingOwner = owner;
  setPhase("opening");
  let id: number;
  try {
    id = await AudioRecord.initSession(options);
  } catch (err) {
    openingOwner = null;
    setPhase("idle");
    if ((err as { code?: string }).code === "busy") {
      await adoptOrphan();
      throw new MicBusyError(getPhase() === "idle" ? "releasing" : getPhase());
    }
    throw err;
  }
  const t: Tracked = {
    id,
    owner,
    collect,
    handlers,
    chunks: new Map(),
    release: null,
    statusLastSeq: null,
    waiters: [],
    finalized: false,
    confirming: null,
    stopRequested: false,
    stopRequest: null,
  };
  current = t;
  openingOwner = null;
  try {
    await AudioRecord.startSession(id);
  } catch (err) {
    // The native side releases a session that failed to start; confirm it.
    setPhase("releasing");
    const outcome = await confirmRelease(t);
    if (outcome === "released") finishReleased(t);
    else setPhase(outcome);
    throw err;
  }
  // A stop that arrived while opening owns the session's state now.
  if (!t.stopRequested) setPhase("capturing");
  return id;
}

/**
 * Stops session `id` and resolves once its release is confirmed — or
 * reports why it couldn't be. `discard`: the audio isn't wanted (Cancel).
 * Calling it again after "stopFailed" retries the stop; after
 * "releaseUnconfirmed", re-checks. A stale id resolves as released without
 * touching the current session.
 */
export async function stopMicSession(id: number, { discard = false }: { discard?: boolean } = {}): Promise<StopResult> {
  return stop(id, discard);
}

async function stop(id: number, discard = false): Promise<StopResult> {
  const t = current;
  if (!t || t.id !== id) {
    return { kind: "released", audio: null };
  }
  t.stopRequested = true;
  if (t.stopRequest || phase === "capturing" || phase === "stopFailed" || phase === "opening") {
    // One native stop request at a time; a concurrent stop joins it.
    if (!t.stopRequest) {
      t.stopRequest = AudioRecord.stopSession(id).finally(() => {
        t.stopRequest = null;
      });
    }
    try {
      await t.stopRequest;
    } catch (error) {
      if (current === t) setPhase("stopFailed");
      return { kind: "stopFailed", error };
    }
    if (current === t && getPhase() !== "idle" && getPhase() !== "releaseUnconfirmed" && getPhase() !== "releaseFailed") {
      setPhase("releasing");
    }
  } else if (phase === "releaseUnconfirmed") {
    await retryMicRelease();
  }
  const now = getPhase();
  const outcome = now === "releaseUnconfirmed" || now === "releaseFailed" ? now : await confirmRelease(t);
  const audio = t.collect && !discard && !t.finalized ? await drain(t) : null;
  if (discard) {
    t.finalized = true;
    t.chunks.clear();
  }
  if (outcome === "released") {
    if (current === t) finishReleased(t);
    return { kind: "released", audio };
  }
  if (current === t) {
    setPhase(outcome);
    if (outcome === "releaseUnconfirmed") startPolling(t);
  }
  return { kind: outcome, audio };
}

/** The user's retry while unconfirmed: force, then ask again. A failed
 * release can't be retried — only an app restart clears it. */
export async function retryMicRelease(): Promise<MicPhase> {
  const t = current;
  if (!t || phase !== "releaseUnconfirmed") return phase;
  stopPolling();
  try {
    await AudioRecord.forceRelease(t.id);
  } catch {
    // The status below decides.
  }
  if (!(await waitForRelease(t, FORCE_RELEASE_WAIT_MS))) {
    const outcome = terminalFromStatus(t, await nativeStatus(t.id));
    if (outcome === "released") finishReleased(t);
    else if (outcome === "releaseFailed") setPhase("releaseFailed");
    else startPolling(t);
    return phase;
  }
  if (t.release?.ok === false) setPhase("releaseFailed");
  else finishReleased(t);
  return phase;
}

/** Tests only: forget all state (the native fake is reset separately). */
export function resetMicSessionForTests(): void {
  stopPolling();
  phase = "idle";
  current = null;
  openingOwner = null;
  subscribed = false;
  listeners.clear();
  phaseWaiters.splice(0);
}
