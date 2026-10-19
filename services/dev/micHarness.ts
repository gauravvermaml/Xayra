import * as FileSystem from "expo-file-system/legacy";
import { getRuntimePackageName } from "expo-app-signature";
import AudioRecord, {
  type MicSessionDataEvent,
  type MicSessionReleasedEvent,
  type MicSessionStatusResult,
} from "@fugood/react-native-audio-pcm-stream";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

import { isMicInUse } from "../audio/audioInputState";
import { isConcurrentTier1Enabled, setConcurrentTier1ForXayraTest } from "../ai/tier1Config";
import { BITS_PER_SAMPLE, CHANNELS, SAMPLE_RATE } from "../audio/wav";

/**
 * Microphone reliability Gate A: emulator test harness for the native
 * session API (MicSessionManager.java). Xayra Test only — opened by
 * `xayra-devtest://dev-mic-harness?run=<scenario>` from adb. Nothing in the
 * app uses the session API yet; this exercises it directly and logs one
 * `[MicHarness]` JSON line per result (counts, ids, states and timestamps
 * only — no audio content).
 *
 * Fault scenarios write `files/dev-mic-fault.json`, which the native side
 * honours only in the `.devtest` package on an emulator; the file is removed
 * when the scenario ends.
 */

const XAYRA_TEST_PACKAGE = "com.anonymous.silentconfidant.devtest";
const FAULT_FILE = `${FileSystem.documentDirectory}dev-mic-fault.json`;
const OPTIONS = { sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE };

export function isMicHarnessAvailable(): boolean {
  try {
    return getRuntimePackageName() === XAYRA_TEST_PACKAGE;
  } catch {
    return false;
  }
}

type Log = (event: string, detail?: Record<string, unknown>) => void;

type SessionRecord = {
  seqs: number[];
  released: MicSessionReleasedEvent[];
  releasedAt: number | null;
  errors: string[];
  silenced: { at: number; supported: boolean; silenced: boolean }[];
  /** Chunks that arrived after this session's release event. */
  lateChunks: number[];
};

const sessions = new Map<number, SessionRecord>();
let subscribed = false;

function record(id: number): SessionRecord {
  let r = sessions.get(id);
  if (!r) {
    r = { seqs: [], released: [], releasedAt: null, errors: [], silenced: [], lateChunks: [] };
    sessions.set(id, r);
  }
  return r;
}

function subscribeOnce(): void {
  if (subscribed) return;
  subscribed = true;
  AudioRecord.onSession("sessionData", (e: MicSessionDataEvent) => {
    const r = record(e.sessionId);
    r.seqs.push(e.seq);
    if (r.releasedAt !== null) r.lateChunks.push(e.seq);
  });
  AudioRecord.onSession("sessionReleased", (e) => {
    const r = record(e.sessionId);
    r.released.push(e);
    if (r.releasedAt === null) r.releasedAt = Date.now();
  });
  AudioRecord.onSession("sessionError", (e) => record(e.sessionId).errors.push(e.message));
  AudioRecord.onSession("sessionSilenced", (e) =>
    record(e.sessionId).silenced.push({ at: Date.now(), supported: e.supported, silenced: e.silenced })
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

/** Completeness by count, never by arrival order. */
function integrity(id: number) {
  const r = record(id);
  const lastSeq = r.released[0]?.lastSeq ?? null;
  const unique = new Set(r.seqs);
  const missing: number[] = [];
  if (lastSeq !== null) {
    for (let seq = 1; seq <= lastSeq; seq++) if (!unique.has(seq)) missing.push(seq);
  }
  let outOfOrder = 0;
  for (let i = 1; i < r.seqs.length; i++) if (r.seqs[i] < r.seqs[i - 1]) outOfOrder++;
  return {
    lastSeq,
    received: r.seqs.length,
    duplicates: r.seqs.length - unique.size,
    missing,
    outOfOrder,
    lateChunks: [...r.lateChunks],
    complete: lastSeq !== null && missing.length === 0 && r.seqs.length === unique.size,
  };
}

async function writeFault(fault: Record<string, unknown> | null): Promise<void> {
  if (fault) {
    await FileSystem.writeAsStringAsync(FAULT_FILE, JSON.stringify(fault));
  } else {
    await FileSystem.deleteAsync(FAULT_FILE, { idempotent: true });
  }
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const code = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err));
    return { ok: false, code };
  }
}

async function status(id: number): Promise<MicSessionStatusResult> {
  return AudioRecord.sessionStatus(id);
}

/** init → start → capture → stop request; returns the id and timings. */
async function captureAndStop(log: Log, captureMs: number) {
  const id = await AudioRecord.initSession(OPTIONS);
  record(id);
  await AudioRecord.startSession(id);
  const startedAt = Date.now();
  await sleep(captureMs);
  const stopRequestedAt = Date.now();
  const stop = await AudioRecord.stopSession(id);
  log("stop-requested", { id, startedAt, stopRequestedAt, stopResult: stop.status });
  return { id, startedAt, stopRequestedAt };
}

async function awaitRelease(id: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => record(id).released.length > 0, timeoutMs);
}

function releaseSummary(id: number) {
  const r = record(id);
  return {
    id,
    releasedEvents: r.released.length,
    releasedAt: r.releasedAt,
    reason: r.released[0]?.reason ?? null,
    ok: r.released[0]?.ok ?? null,
    errors: r.errors.length,
    silenced: r.silenced,
    integrity: integrity(id),
  };
}

type Scenario = (log: Log) => Promise<boolean>;

const scenarios: Record<string, Scenario> = {
  // Gate B: switch concurrent Tier 1 (the on-device recognizer started
  // beside each manual recording) for the on/off comparison.
  TIER1_OFF: async (log) => {
    const ok = await setConcurrentTier1ForXayraTest(false);
    log("result", { concurrentTier1: isConcurrentTier1Enabled() });
    return ok && !isConcurrentTier1Enabled();
  },
  TIER1_ON: async (log) => {
    const ok = await setConcurrentTier1ForXayraTest(true);
    log("result", { concurrentTier1: isConcurrentTier1Enabled() });
    return ok && isConcurrentTier1Enabled();
  },

  // A1: normal start/stop; the acknowledgement follows native cleanup
  // (the host correlates releasedAt with dumpsys audio's "rec stop").
  A1: async (log) => {
    const { id, stopRequestedAt } = await captureAndStop(log, 2000);
    const got = await awaitRelease(id, 3000);
    const s = releaseSummary(id);
    log("result", { ...s, ackLatencyMs: s.releasedAt ? s.releasedAt - stopRequestedAt : null, status: (await status(id)).status });
    return got && s.releasedEvents === 1 && s.ok === true && s.integrity.complete;
  },

  // A2: no second session while the first is unreleased.
  A2: async (log) => {
    const first = await AudioRecord.initSession(OPTIONS);
    const secondWhileInitialized = await attempt(() => AudioRecord.initSession(OPTIONS));
    await AudioRecord.startSession(first);
    await sleep(500);
    const secondWhileCapturing = await attempt(() => AudioRecord.initSession(OPTIONS));
    await AudioRecord.stopSession(first);
    const secondWhileStopping = await attempt(() => AudioRecord.initSession(OPTIONS));
    await awaitRelease(first, 3000);
    const afterRelease = await attempt(() => AudioRecord.initSession(OPTIONS));
    if (afterRelease.ok) {
      await AudioRecord.stopSession(afterRelease.value);
      await awaitRelease(afterRelease.value, 3000);
    }
    log("result", {
      first,
      secondWhileInitialized: secondWhileInitialized.ok ? "OPENED" : secondWhileInitialized.code,
      secondWhileCapturing: secondWhileCapturing.ok ? "OPENED" : secondWhileCapturing.code,
      secondWhileStopping: secondWhileStopping.ok ? "OPENED" : secondWhileStopping.code,
      afterRelease: afterRelease.ok ? "opened" : afterRelease.code,
    });
    return !secondWhileInitialized.ok && !secondWhileCapturing.ok && afterRelease.ok;
    // secondWhileStopping may legitimately open if release completed first;
    // it is reported, and the dumpsys check shows no overlap.
  },

  // A3: legacy API vs session API refuse each other.
  A3: async (log) => {
    const id = await AudioRecord.initSession(OPTIONS);
    await AudioRecord.startSession(id);
    const legacyWhileSession = await attempt(() => AudioRecord.init(OPTIONS) as unknown as Promise<void>);
    await AudioRecord.stopSession(id);
    await awaitRelease(id, 3000);

    AudioRecord.init(OPTIONS);
    AudioRecord.start();
    await sleep(800);
    const sessionWhileLegacy = await attempt(() => AudioRecord.initSession(OPTIONS));
    AudioRecord.stop();
    // The legacy path has no acknowledgement: retry until it lets go.
    let opened: number | null = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && opened === null) {
      const r = await attempt(() => AudioRecord.initSession(OPTIONS));
      if (r.ok) opened = r.value;
      else await sleep(50);
    }
    if (opened !== null) {
      await AudioRecord.stopSession(opened);
      await awaitRelease(opened, 3000);
    }
    log("result", {
      legacyWhileSession: legacyWhileSession.ok ? "OPENED" : legacyWhileSession.code,
      sessionWhileLegacy: sessionWhileLegacy.ok ? "OPENED" : sessionWhileLegacy.code,
      sessionAfterLegacyStop: opened !== null ? "opened" : "never",
    });
    return !legacyWhileSession.ok && !sessionWhileLegacy.ok && opened !== null;
  },

  // A4: repeated stop, a stale id, an unknown id.
  A4: async (log) => {
    const first = await AudioRecord.initSession(OPTIONS);
    await AudioRecord.startSession(first);
    await sleep(500);
    const stop1 = await AudioRecord.stopSession(first);
    const stop2 = await attempt(() => AudioRecord.stopSession(first));
    await awaitRelease(first, 3000);
    const stopAfterRelease = await attempt(() => AudioRecord.stopSession(first));
    const second = await AudioRecord.initSession(OPTIONS);
    await AudioRecord.startSession(second);
    await sleep(300);
    const staleStop = await attempt(() => AudioRecord.stopSession(first));
    const secondAfterStale = await status(second);
    const unknownStop = await attempt(() => AudioRecord.stopSession(987654321));
    await AudioRecord.stopSession(second);
    await awaitRelease(second, 3000);
    const firstEvents = record(first).released.length;
    log("result", {
      stop1: stop1.status,
      stop2: stop2.ok ? stop2.value.status : stop2.code,
      stopAfterRelease: stopAfterRelease.ok ? stopAfterRelease.value.status : stopAfterRelease.code,
      staleStop: staleStop.ok ? staleStop.value.status : staleStop.code,
      secondAfterStale: secondAfterStale.status,
      unknownStop: unknownStop.ok ? "RESOLVED" : unknownStop.code,
      firstReleasedEvents: firstEvents,
      secondReleasedEvents: record(second).released.length,
    });
    return (
      firstEvents === 1 &&
      record(second).released.length === 1 &&
      secondAfterStale.status === "capturing" &&
      !unknownStop.ok
    );
  },

  // A5: init without start, then stop: released exactly once.
  A5: async (log) => {
    const id = await AudioRecord.initSession(OPTIONS);
    await AudioRecord.stopSession(id);
    await awaitRelease(id, 2000);
    const next = await attempt(() => AudioRecord.initSession(OPTIONS));
    if (next.ok) {
      await AudioRecord.stopSession(next.value);
      await awaitRelease(next.value, 2000);
    }
    const s = releaseSummary(id);
    log("result", { ...s, status: (await status(id)).status, nextInit: next.ok ? "opened" : next.code });
    return s.releasedEvents === 1 && s.reason === "stoppedBeforeStart" && next.ok;
  },

  // A6: start failure releases and frees ownership.
  A6: async (log) => {
    await writeFault({ failStartSession: true });
    const id = await AudioRecord.initSession(OPTIONS);
    const start = await attempt(() => AudioRecord.startSession(id));
    await awaitRelease(id, 2000);
    await writeFault(null);
    const next = await attempt(() => AudioRecord.initSession(OPTIONS));
    if (next.ok) {
      await AudioRecord.stopSession(next.value);
      await awaitRelease(next.value, 2000);
    }
    const s = releaseSummary(id);
    log("result", { start: start.ok ? "STARTED" : start.code, ...s, nextInit: next.ok ? "opened" : next.code });
    return !start.ok && s.reason === "startFailed" && s.releasedEvents === 1 && next.ok;
  },

  // A7: forceRelease during active capture.
  A7: async (log) => {
    const id = await AudioRecord.initSession(OPTIONS);
    await AudioRecord.startSession(id);
    await sleep(1500);
    const forcedAt = Date.now();
    const force = await AudioRecord.forceRelease(id);
    const got = await awaitRelease(id, 3000);
    await sleep(300); // any duplicate acknowledgement would arrive here
    const s = releaseSummary(id);
    log("result", { force: force.status, ...s, ackLatencyMs: s.releasedAt ? s.releasedAt - forcedAt : null });
    return got && s.releasedEvents === 1 && s.ok === true;
  },

  // A8: a wedged capture thread keeps ownership until it really releases.
  A8: async (log) => {
    await writeFault({ holdThreadMs: 4000 });
    const { id } = await captureAndStop(log, 800);
    await sleep(1000);
    const during = await status(id);
    const initDuring = await attempt(() => AudioRecord.initSession(OPTIONS));
    const force = await AudioRecord.forceRelease(id);
    await sleep(500);
    const afterForce = await status(id);
    const got = await awaitRelease(id, 6000);
    await writeFault(null);
    const next = await attempt(() => AudioRecord.initSession(OPTIONS));
    if (next.ok) {
      await AudioRecord.stopSession(next.value);
      await awaitRelease(next.value, 2000);
    }
    log("result", {
      during: during.status,
      initDuring: initDuring.ok ? "OPENED" : initDuring.code,
      force: force.status,
      afterForce: afterForce.status,
      releasedEventually: got,
      ...releaseSummary(id),
      nextInit: next.ok ? "opened" : next.code,
    });
    return during.status === "stopping" && !initDuring.ok && afterForce.status === "stopping" && got && next.ok;
  },

  // A9: a lost acknowledgement — status still reports the real release.
  A9: async (log) => {
    await writeFault({ dropReleased: true });
    const { id } = await captureAndStop(log, 800);
    const got = await awaitRelease(id, 2000);
    const st = await status(id);
    await writeFault(null);
    const next = await attempt(() => AudioRecord.initSession(OPTIONS));
    if (next.ok) {
      await AudioRecord.stopSession(next.value);
      await awaitRelease(next.value, 2000);
    }
    log("result", { eventArrived: got, status: st.status, lastSeq: st.lastSeq, nextInit: next.ok ? "opened" : next.code });
    return !got && st.status === "released" && next.ok;
  },

  // A10: a failed release keeps ownership (the app needs a restart after).
  A10: async (log) => {
    await writeFault({ failRelease: true });
    const { id } = await captureAndStop(log, 800);
    await awaitRelease(id, 3000);
    await writeFault(null);
    const st = await status(id);
    const current = await status(0);
    const next = await attempt(() => AudioRecord.initSession(OPTIONS));
    const legacy = await attempt(() => AudioRecord.init(OPTIONS) as unknown as Promise<void>);
    log("result", {
      ...releaseSummary(id),
      status: st.status,
      currentOwner: current,
      nextInit: next.ok ? "OPENED" : next.code,
      legacyInit: legacy.ok ? "OPENED" : legacy.code,
    });
    return st.status === "releaseFailed" && current.sessionId === id && !next.ok && !legacy.ok;
  },

  // A11: rapid cycles; a delayed acknowledgement is matched to its own id.
  A11: async (log) => {
    const ids: number[] = [];
    let busyDuringRelease = 0;
    for (let i = 0; i < 20; i++) {
      const id = await AudioRecord.initSession(OPTIONS);
      ids.push(id);
      await AudioRecord.startSession(id);
      await sleep(100 + (i % 4) * 50);
      await AudioRecord.stopSession(id);
      const early = await attempt(() => AudioRecord.initSession(OPTIONS));
      if (!early.ok) busyDuringRelease++;
      else {
        // Released already: legitimate. Close it straight away.
        ids.push(early.value);
        await AudioRecord.stopSession(early.value);
        await awaitRelease(early.value, 3000);
      }
      await awaitRelease(id, 3000);
    }
    // Delayed acknowledgement for one session while the next one runs.
    await writeFault({ delayReleasedMs: 1500 });
    const delayed = await AudioRecord.initSession(OPTIONS);
    await writeFault(null);
    await AudioRecord.startSession(delayed);
    await sleep(300);
    await AudioRecord.stopSession(delayed);
    const releasedNatively = await waitFor(() => false, 300).then(() => status(delayed));
    const next = await AudioRecord.initSession(OPTIONS);
    await AudioRecord.startSession(next);
    await waitFor(() => record(delayed).released.length > 0, 3000);
    const nextWhenDelayedAckArrived = await status(next);
    await AudioRecord.stopSession(next);
    await awaitRelease(next, 3000);
    const counts = [...ids, delayed, next].map((id) => record(id).released.length);
    const delayedEvent = record(delayed).released[0];
    log("result", {
      sessions: counts.length,
      everyReleasedOnce: counts.every((c) => c === 1),
      busyDuringRelease,
      delayedNativeStatusBeforeAck: releasedNatively.status,
      delayedAckSessionId: delayedEvent?.sessionId ?? null,
      nextWhenDelayedAckArrived: nextWhenDelayedAckArrived.status,
    });
    return counts.every((c) => c === 1) && delayedEvent?.sessionId === delayed && nextWhenDelayedAckArrived.status === "capturing";
  },

  // Audio-event integrity: a deferred chunk (out of order, after release)
  // and a dropped chunk — the shortfall must be reported, never hidden.
  INTEGRITY: async (log) => {
    await writeFault({ deferChunkSeq: 5, deferChunkMs: 2500 });
    const deferred = await captureAndStop(log, 1500);
    await awaitRelease(deferred.id, 3000);
    const atRelease = integrity(deferred.id);
    await sleep(2500);
    const afterLate = integrity(deferred.id);

    await writeFault({ dropChunkSeq: 7 });
    const dropped = await captureAndStop(log, 1500);
    await awaitRelease(dropped.id, 3000);
    await sleep(500);
    const droppedIntegrity = integrity(dropped.id);
    await writeFault(null);
    log("result", { deferredAtRelease: atRelease, deferredAfterLate: afterLate, dropped: droppedIntegrity });
    return (
      !atRelease.complete &&
      atRelease.missing.includes(5) &&
      afterLate.complete &&
      afterLate.lateChunks.includes(5) &&
      !droppedIntegrity.complete &&
      droppedIntegrity.missing.includes(7)
    );
  },

  // Native stop failure: the session keeps capturing; a retry stops it.
  STOPFAIL: async (log) => {
    await writeFault({ failStopCount: 1 });
    const id = await AudioRecord.initSession(OPTIONS);
    await writeFault(null);
    await AudioRecord.startSession(id);
    await sleep(800);
    const firstStop = await attempt(() => AudioRecord.stopSession(id));
    const afterFailed = await status(id);
    await sleep(800);
    const chunksBeforeRetry = record(id).seqs.length;
    const retry = await AudioRecord.stopSession(id);
    const got = await awaitRelease(id, 3000);
    log("result", {
      firstStop: firstStop.ok ? "STOPPED" : firstStop.code,
      afterFailed: afterFailed.status,
      chunksBeforeRetry,
      retry: retry.status,
      released: got,
      ...releaseSummary(id),
    });
    return !firstStop.ok && afterFailed.status === "capturing" && got;
  },

  // D7: a 10 s capture the host backgrounds and resumes (Home key) partway
  // through, to see silencing reported for our own session.
  HOLD10: async (log) => {
    const { id } = await captureAndStop(log, 10000);
    await awaitRelease(id, 3000);
    const silencedSeen = record(id).silenced.some((e) => e.silenced);
    log("result", { silencedSeen, ...releaseSummary(id) });
    return record(id).released.length === 1;
  },

  // D7: silenced-capture diagnostic. Starts the on-device recognizer as a
  // competing capture while a session runs (diagnostic only).
  SILENCED: async (log) => {
    const id = await AudioRecord.initSession(OPTIONS);
    await AudioRecord.startSession(id);
    await sleep(1500);
    let recognizer = "not-started";
    try {
      ExpoSpeechRecognitionModule.start({ lang: "en-US", interimResults: false, continuous: false, requiresOnDeviceRecognition: true });
      recognizer = "started";
    } catch (err) {
      recognizer = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const recognizerAt = Date.now();
    // The on-device recognizer needs a few seconds before it opens the mic.
    await sleep(8000);
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // Already ended.
    }
    const abortedAt = Date.now();
    await sleep(1500);
    await AudioRecord.stopSession(id);
    await awaitRelease(id, 3000);
    const silencedSeen = record(id).silenced.some((e) => e.silenced);
    log("result", { recognizer, recognizerAt, abortedAt, silencedSeen, ...releaseSummary(id) });
    // Diagnostic: passes when the signal is reported at all; whether it saw
    // silencing is the finding (cross-checked against dumpsys audio).
    return record(id).silenced.some((e) => e.supported);
  },
};

// Gate B: faults for the app's own recordings. Each only writes the fault
// file (applied to every native session opened after it, in Xayra Test on
// an emulator) and leaves it in place until FAULT_CLEAR.
const appFaults: Record<string, Record<string, unknown> | null> = {
  FAULT_DROP: { dropReleased: true },
  FAULT_DELAY: { delayReleasedMs: 1500 },
  FAULT_STUCK: { holdThreadMs: 9000 },
  FAULT_FAILRELEASE: { failRelease: true },
  FAULT_STOPFAIL: { failStopCount: 1 },
  FAULT_CLEAR: null,
};
for (const [name, fault] of Object.entries(appFaults)) {
  scenarios[name] = async (log) => {
    await writeFault(fault);
    log("result", { fault });
    return true;
  };
}

export const MIC_HARNESS_SCENARIOS = Object.keys(scenarios);

export async function runMicHarness(name: string, log: Log): Promise<void> {
  const scenario = scenarios[name];
  if (!isMicHarnessAvailable()) {
    log("unavailable");
    return;
  }
  if (!scenario) {
    log("unknown-scenario", { name });
    return;
  }
  if (isMicInUse()) {
    log("refused", { reason: "the app's own recorder is in use" });
    return;
  }
  subscribeOnce();
  const startedAt = Date.now();
  let passed = false;
  try {
    passed = await scenario(log);
  } catch (err) {
    log("threw", { message: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code ?? null });
  } finally {
    // App-level faults stay until FAULT_CLEAR; scenario faults never do.
    if (!name.startsWith("FAULT_")) await writeFault(null).catch(() => {});
  }
  log(passed ? "PASS" : "FAIL", { name, durationMs: Date.now() - startedAt });
}
