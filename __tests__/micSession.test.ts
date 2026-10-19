/**
 * Microphone reliability Gate B: the shared microphone owner. MOCK-BASED —
 * the native module is __tests__/support/fakeMicNative.ts; real native
 * release is verified on the emulator.
 */
jest.mock("@fugood/react-native-audio-pcm-stream", () => require("./support/fakeMicNative").fakeMicModule);

import { Buffer } from "buffer";
import AudioRecord from "@fugood/react-native-audio-pcm-stream";

import { fakeMic } from "./support/fakeMicNative";
import {
  FORCE_RELEASE_WAIT_MS,
  getMicSnapshot,
  isMicSessionBusy,
  MicBusyError,
  openMicSession,
  RELEASE_ACK_TIMEOUT_MS,
  resetMicSessionForTests,
  stopMicSession,
  UNCONFIRMED_POLL_MS,
  type StopResult,
} from "../services/audio/micSession";
import { isMicInUse } from "../services/audio/audioInputState";

const OPTIONS = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };
const chunk = (n: number) => Buffer.from([n, n]).toString("base64");

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await flush();
}
/** Runs a stop to completion through every timer it may wait on. */
async function settle(p: Promise<StopResult>, maxMs = 10000): Promise<StopResult> {
  let result: StopResult | null = null;
  void p.then((r) => (result = r));
  for (let t = 0; t < maxMs && !result; t += 25) await advance(25);
  if (!result) throw new Error("stop did not settle");
  return result;
}

beforeEach(() => {
  jest.useFakeTimers();
  fakeMic.reset();
  resetMicSessionForTests();
});
afterEach(() => jest.useRealTimers());

const open = (collect = true) => openMicSession("manual", OPTIONS, {}, { collect });

describe("micSession", () => {
  it("normal: busy while capturing, free only after the release acknowledgement; audio complete and ordered", async () => {
    const id = await open();
    expect(getMicSnapshot()).toEqual({ phase: "capturing", owner: "manual", sessionId: id });
    expect(isMicInUse()).toBe(true);
    [1, 2, 3].forEach((n) => fakeMic.emit(chunk(n)));
    const result = await settle(stopMicSession(id));
    expect(result.kind).toBe("released");
    if (result.kind !== "released" || !result.audio) throw new Error();
    expect(result.audio.complete).toBe(true);
    expect(result.audio.lastSeq).toBe(3);
    expect(result.audio.chunks.map((b) => b[0])).toEqual([1, 2, 3]);
    expect(isMicSessionBusy()).toBe(false);
    expect(isMicInUse()).toBe(false);
  });

  it("a successful stop request is not release: busy until the acknowledgement, however late", async () => {
    fakeMic.ackMode = "manual";
    const id = await open();
    const stop = stopMicSession(id);
    await flush();
    expect(AudioRecord.stopSession).toHaveBeenCalledWith(id);
    expect(getMicSnapshot().phase).toBe("releasing");
    await advance(RELEASE_ACK_TIMEOUT_MS - 100);
    expect(isMicInUse()).toBe(true);
    fakeMic.releaseNow();
    expect((await settle(stop)).kind).toBe("released");
    expect(isMicInUse()).toBe(false);
  });

  it("a lost acknowledgement is resolved by the native status, with lastSeq from it", async () => {
    fakeMic.ackMode = "drop";
    const id = await open();
    fakeMic.emit(chunk(1));
    fakeMic.emit(chunk(2));
    const result = await settle(stopMicSession(id));
    expect(AudioRecord.sessionStatus).toHaveBeenCalledWith(id);
    expect(result.kind).toBe("released");
    if (result.kind !== "released") throw new Error();
    expect(result.audio?.lastSeq).toBe(2);
    expect(result.audio?.complete).toBe(true);
    expect(isMicInUse()).toBe(false);
  });

  it("never released: forced stop, then 'releaseUnconfirmed' — busy, new captures refused, until native confirms", async () => {
    fakeMic.ackMode = "manual";
    fakeMic.stuck = true;
    const id = await open();
    const result = await settle(stopMicSession(id));
    expect(AudioRecord.forceRelease).toHaveBeenCalledWith(id);
    expect(result.kind).toBe("releaseUnconfirmed");
    if (result.kind !== "releaseUnconfirmed") throw new Error();
    expect(result.audio?.complete).toBe(false); // completeness unknown
    expect(getMicSnapshot().phase).toBe("releaseUnconfirmed");
    expect(isMicInUse()).toBe(true);

    // A new capture is refused while ownership is uncertain (the attempt
    // re-checks first — still stuck).
    let refused: unknown = null;
    void open().catch((err) => (refused = err));
    for (let t = 0; t < FORCE_RELEASE_WAIT_MS + 500 && !refused; t += 25) await advance(25);
    expect(refused).toBeInstanceOf(MicBusyError);
    expect(AudioRecord.initSession).toHaveBeenCalledTimes(1);

    // The thread finally finishes: the periodic re-check sees it.
    fakeMic.stuck = false;
    fakeMic.releaseNow();
    await advance(UNCONFIRMED_POLL_MS + 100);
    expect(getMicSnapshot().phase).toBe("idle");
    expect(isMicInUse()).toBe(false);
  });

  it("a failed native release keeps the microphone busy; nothing can open", async () => {
    fakeMic.failRelease = true;
    const id = await open();
    const result = await settle(stopMicSession(id));
    expect(result.kind).toBe("releaseFailed");
    expect(getMicSnapshot().phase).toBe("releaseFailed");
    await expect(open()).rejects.toBeInstanceOf(MicBusyError);
    await advance(UNCONFIRMED_POLL_MS * 2);
    expect(isMicInUse()).toBe(true);
  });

  it("a failed stop request: still capturing (and collecting); a second stop releases", async () => {
    fakeMic.failStopCount = 1;
    const id = await open();
    fakeMic.emit(chunk(1));
    const first = await settle(stopMicSession(id));
    expect(first.kind).toBe("stopFailed");
    expect(getMicSnapshot().phase).toBe("stopFailed");
    expect(isMicInUse()).toBe(true);
    fakeMic.emit(chunk(2));
    const second = await settle(stopMicSession(id));
    expect(second.kind).toBe("released");
    if (second.kind !== "released") throw new Error();
    expect(second.audio?.chunks.map((b) => b[0])).toEqual([1, 2]);
  });

  it("stale events: another session's chunks and acknowledgements never touch the current one", async () => {
    const first = await open();
    await settle(stopMicSession(first));
    const second = await open();
    fakeMic.fireData(first, 99, chunk(9)); // late chunk from the old recording
    fakeMic.fireReleased(first, 5); // late acknowledgement for the old recording
    fakeMic.emit(chunk(1));
    expect(getMicSnapshot()).toMatchObject({ phase: "capturing", sessionId: second });
    const result = await settle(stopMicSession(second));
    if (result.kind !== "released") throw new Error();
    expect(result.audio?.chunks.map((b) => b[0])).toEqual([1]);
    // A stop for the old id is a no-op.
    expect((await settle(stopMicSession(first))).kind).toBe("released");
  });

  it("a missing middle chunk: reported, the rest kept in order", async () => {
    fakeMic.dropSeqs.add(2);
    const id = await open();
    [1, 2, 3].forEach((n) => fakeMic.emit(chunk(n)));
    const result = await settle(stopMicSession(id));
    if (result.kind !== "released" || !result.audio) throw new Error();
    expect(result.audio).toMatchObject({ complete: false, missing: [2], tailMissing: false, lastSeq: 3 });
    expect(result.audio.chunks.map((b) => b[0])).toEqual([1, 3]);
  });

  it("a missing final chunk: reported as a cut-off tail", async () => {
    fakeMic.dropSeqs.add(3);
    const id = await open();
    [1, 2, 3].forEach((n) => fakeMic.emit(chunk(n)));
    const result = await settle(stopMicSession(id));
    if (result.kind !== "released" || !result.audio) throw new Error();
    expect(result.audio).toMatchObject({ complete: false, missing: [3], tailMissing: true });
  });

  it("a chunk delivered late (after release, within the drain) still completes the audio, in order", async () => {
    fakeMic.holdSeqs.add(2);
    const id = await open();
    [1, 2, 3].forEach((n) => fakeMic.emit(chunk(n)));
    const stop = stopMicSession(id);
    await flush();
    fakeMic.deliverHeld();
    const result = await settle(stop);
    if (result.kind !== "released" || !result.audio) throw new Error();
    expect(result.audio.complete).toBe(true);
    expect(result.audio.chunks.map((b) => b[0])).toEqual([1, 2, 3]);
  });

  it("discard (Cancel): released, no audio returned", async () => {
    const id = await open();
    fakeMic.emit(chunk(1));
    const result = await settle(stopMicSession(id, { discard: true }));
    expect(result).toEqual({ kind: "released", audio: null });
  });

  it("concurrent stops share one confirmation; one native stop request", async () => {
    fakeMic.ackMode = "manual";
    const id = await open();
    const a = stopMicSession(id);
    const b = stopMicSession(id);
    await flush();
    fakeMic.releaseNow();
    const [ra, rb] = await Promise.all([settle(a), settle(b)]);
    expect(ra.kind).toBe("released");
    expect(rb.kind).toBe("released");
    expect(AudioRecord.stopSession).toHaveBeenCalledTimes(1);
  });

  it("an open while the previous session is still releasing waits for it, then opens", async () => {
    fakeMic.ackMode = "manual";
    const first = await open();
    void stopMicSession(first);
    await flush();
    let second: number | null = null;
    void open().then((id) => (second = id));
    await advance(300);
    expect(second).toBeNull();
    expect(AudioRecord.initSession).toHaveBeenCalledTimes(1); // nothing new opened yet
    fakeMic.releaseNow();
    await advance(100);
    expect(second).not.toBeNull();
  });

  it("a start failure: rejected, and the microphone is free once native confirms", async () => {
    fakeMic.failStart = true;
    await expect(open()).rejects.toMatchObject({ code: "startFailed" });
    expect(getMicSnapshot().phase).toBe("idle");
  });

  it("an orphan native session (from a torn-down instance) is closed, never opened over", async () => {
    // A native owner this JS context never opened.
    await (AudioRecord.initSession as jest.Mock)(OPTIONS);
    await (AudioRecord.startSession as jest.Mock)(1);
    let refused: unknown = null;
    void open().catch((err) => (refused = err));
    await advance(100);
    expect(refused).toBeInstanceOf(MicBusyError);
    expect(AudioRecord.stopSession).toHaveBeenCalledWith(1);
    await advance(100);
    expect(getMicSnapshot().phase).toBe("idle");
    await expect(open()).resolves.toBe(2);
  });

  it("Handsfree-style capture: chunks go to the live handler only while capturing; nothing is collected", async () => {
    const seen: string[] = [];
    const id = await openMicSession("handsfree", OPTIONS, { onChunk: (b) => seen.push(b) }, { collect: false });
    fakeMic.emit(chunk(1));
    const result = await settle(stopMicSession(id));
    expect(seen).toHaveLength(1);
    expect(result).toEqual({ kind: "released", audio: null });
  });
});
