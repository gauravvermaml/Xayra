/**
 * A controllable stand-in for @fugood/react-native-audio-pcm-stream: the
 * legacy init/start/stop/on API and Gate A's session API, with the native
 * lifecycle rules (one unreleased session at a time; a failed release keeps
 * ownership) modelled in JS. MOCK ONLY — real native behaviour is verified
 * on the emulator (services/dev/micHarness.ts).
 *
 *   jest.mock("@fugood/react-native-audio-pcm-stream", () => require("./support/fakeMicNative").fakeMicModule);
 *   import { fakeMic } from "./support/fakeMicNative";
 */

type Listener = (event: never) => void;
type NativeState = "initialized" | "capturing" | "stopping" | "released" | "releaseFailed";
type Session = { id: number; state: NativeState; seq: number };

const listeners = new Map<string, Set<Listener>>();
let legacyData: ((base64: string) => void) | null = null;
let legacyActive = false;
let owner: Session | null = null;
const history = new Map<number, { state: NativeState; lastSeq: number }>();
let nextId = 1;

export const fakeMic = {
  /** "auto": release acknowledged right after the stop request;
   * "manual": only when a test calls releaseNow(); "drop": released
   * natively, but the acknowledgement never arrives. */
  ackMode: "auto" as "auto" | "manual" | "drop",
  /** Remaining stop requests to reject (the stop never takes effect). */
  failStopCount: 0,
  failStart: false,
  /** The release throws: ownership is kept. */
  failRelease: false,
  /** The capture thread never finishes: forceRelease doesn't help. */
  stuck: false,
  /** Chunk sequence numbers to swallow (they still count toward lastSeq). */
  dropSeqs: new Set<number>(),
  /** Chunks held back, delivered by deliverHeld(). */
  holdSeqs: new Set<number>(),
  held: [] as Array<{ sessionId: number; seq: number; data: string }>,

  get owner(): Session | null {
    return owner;
  },

  reset(): void {
    listeners.clear();
    legacyData = null;
    legacyActive = false;
    owner = null;
    history.clear();
    nextId = 1;
    fakeMic.ackMode = "auto";
    fakeMic.failStopCount = 0;
    fakeMic.failStart = false;
    fakeMic.failRelease = false;
    fakeMic.stuck = false;
    fakeMic.dropSeqs.clear();
    fakeMic.holdSeqs.clear();
    fakeMic.held = [];
    Object.values(fakeMicModule.default).forEach((fn) => (fn as jest.Mock).mockClear?.());
  },

  /** One PCM chunk from the "microphone": to the capturing session, else
   * the legacy listener. */
  emit(base64: string): void {
    if (owner && (owner.state === "capturing" || owner.state === "stopping")) {
      const seq = ++owner.seq;
      if (fakeMic.dropSeqs.has(seq)) return;
      const event = { sessionId: owner.id, seq, data: base64 };
      if (fakeMic.holdSeqs.has(seq)) {
        fakeMic.held.push(event);
        return;
      }
      fire("sessionData", event);
      return;
    }
    if (legacyActive) legacyData?.(base64);
  },

  deliverHeld(): void {
    fakeMic.held.splice(0).forEach((event) => fire("sessionData", event));
  },

  /** Completes a pending release (ackMode "manual", or after "stuck"). */
  releaseNow(ok = true): void {
    if (owner && (owner.state === "stopping" || owner.state === "capturing")) {
      release(owner, ok);
    }
  },

  /** Sends a release acknowledgement for any id (to test stale events). */
  fireReleased(sessionId: number, lastSeq = 0): void {
    fire("sessionReleased", { sessionId, status: "released", lastSeq, reason: "stopped", ok: true });
  },

  /** A raw chunk event for any session id (to test stale chunks). */
  fireData(sessionId: number, seq: number, data: string): void {
    fire("sessionData", { sessionId, seq, data });
  },

  fireError(message: string): void {
    if (owner) fire("sessionError", { sessionId: owner.id, message });
  },
};

function fire(event: string, payload: unknown): void {
  listeners.get(event)?.forEach((listener) => (listener as (e: unknown) => void)(payload));
}

function release(s: Session, ok = !fakeMic.failRelease, reason = "stopped"): void {
  const state: NativeState = ok ? "released" : "releaseFailed";
  s.state = state;
  if (ok && owner === s) owner = null;
  history.set(s.id, { state, lastSeq: s.seq });
  if (fakeMic.ackMode === "drop") return;
  fire("sessionReleased", { sessionId: s.id, status: state, lastSeq: s.seq, reason, ok });
}

function statusOf(id: number) {
  if (id <= 0) return owner ? { sessionId: owner.id, status: owner.state } : { sessionId: 0, status: "none" };
  if (owner && owner.id === id) return { sessionId: id, status: owner.state };
  const h = history.get(id);
  if (h) return { sessionId: id, status: h.state, lastSeq: h.lastSeq };
  return { sessionId: id, status: "unknown" };
}

const rejectWith = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));

export const fakeMicModule = {
  __esModule: true,
  default: {
    // ---- legacy ----
    init: jest.fn(() => {
      if (owner) return rejectWith("busy");
      return Promise.resolve();
    }),
    start: jest.fn(() => {
      legacyActive = true;
    }),
    stop: jest.fn(() => {
      legacyActive = false;
    }),
    on: jest.fn((event: string, handler: (data: string) => void) => {
      if (event === "data") legacyData = handler;
      return { remove: jest.fn() };
    }),

    // ---- session API ----
    initSession: jest.fn(() => {
      if (owner || legacyActive) return rejectWith("busy");
      owner = { id: nextId++, state: "initialized", seq: 0 };
      return Promise.resolve(owner.id);
    }),
    startSession: jest.fn((id: number) => {
      if (!owner || owner.id !== id) return rejectWith("notOwner");
      if (fakeMic.failStart) {
        release(owner, true, "startFailed");
        return rejectWith("startFailed");
      }
      owner.state = "capturing";
      return Promise.resolve();
    }),
    stopSession: jest.fn((id: number) => {
      if (fakeMic.failStopCount > 0) {
        fakeMic.failStopCount--;
        return rejectWith("stopFailed");
      }
      if (!owner || owner.id !== id) {
        return history.has(id) ? Promise.resolve(statusOf(id)) : rejectWith("unknownSession");
      }
      const s = owner;
      if (s.state === "initialized") {
        release(s, !fakeMic.failRelease, "stoppedBeforeStart");
      } else if (s.state === "capturing") {
        s.state = "stopping";
        if (fakeMic.ackMode !== "manual" && !fakeMic.stuck) {
          void Promise.resolve().then(() => {
            if (s.state === "stopping") release(s);
          });
        }
      }
      return Promise.resolve(statusOf(id));
    }),
    forceRelease: jest.fn((id: number) => {
      if (owner && owner.id === id && !fakeMic.stuck && (owner.state === "stopping" || owner.state === "capturing")) {
        owner.state = "stopping";
        release(owner);
      }
      return Promise.resolve(statusOf(id));
    }),
    sessionStatus: jest.fn((id: number) => Promise.resolve(statusOf(id))),
    onSession: jest.fn((event: string, callback: Listener) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(callback);
      return { remove: () => set?.delete(callback) };
    }),
  },
};
