/**
 * Xayra 2.0 Stage 5b correction: an explicit Handsfree Stop stops the
 * interaction in progress. MOCKED: the steps below are fakes held open on
 * promises, driven in the order app/index.tsx's finishUtterance runs them
 * (transcribe → cancelled? → route, which commits just before a note write
 * → may it speak? → speak), with the real ProcessingJob and the real
 * interrupt helpers the screen calls. Real speech, Whisper and the LLM are
 * not exercised here (the emulator has no speech input).
 */
import { ProcessingJob } from "../services/ai/processingJob";
import { interruptHandsfreeWork, mayHandsfreeSpeak } from "../services/audio/handsfreeInterrupt";

type Step = { started: boolean; finish: () => void; promise: Promise<void> };
function heldStep(): Step {
  let finish!: () => void;
  const step: Step = { started: false, finish: () => finish(), promise: Promise.resolve() };
  step.promise = new Promise<void>((resolve) => (finish = resolve));
  return step;
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** One Handsfree utterance, as finishUtterance runs it. */
function runUtterance(intent: "RECORD" | "ASK") {
  const job = new ProcessingJob();
  const interrupted = new WeakSet<ProcessingJob>();
  const log: string[] = [];
  const transcribe = heldStep();
  const generate = heldStep();
  const write = heldStep();
  const speech = heldStep();
  const aborts = { whisper: 0, llm: 0 };
  job.onCancel(() => aborts.whisper++);

  const done = (async () => {
    log.push("transcribe");
    await transcribe.promise;
    if (job.cancelled) return log.push("stopped after transcription");
    if (intent === "RECORD") {
      if (!job.commit()) return log.push("note not written");
      log.push("note write started");
      await write.promise;
      log.push("note saved");
    } else {
      job.onCancel(() => aborts.llm++);
      log.push("generate");
      await generate.promise;
      if (job.cancelled) return log.push("answer discarded");
      log.push("answer in history");
    }
    if (!mayHandsfreeSpeak(job, interrupted)) return log.push("nothing spoken");
    log.push("speaking");
    await speech.promise;
    log.push("spoke to the end");
  })();

  const stop = (isSpeaking = false) => {
    const stopSpeech = jest.fn(() => speech.finish());
    const onCancelled = jest.fn();
    const result = interruptHandsfreeWork({ handsfreeJob: job, interrupted, isSpeaking, stopSpeech, onCancelled });
    return { result, stopSpeech, onCancelled };
  };
  return { job, log, transcribe, generate, write, speech, aborts, done, stop };
}

describe("explicit Stop by Handsfree phase (mocked pipeline)", () => {
  it("during transcription: Whisper aborted, nothing routed, nothing saved or spoken", async () => {
    const u = runUtterance("RECORD");
    const { result, onCancelled } = u.stop();
    expect(result).toEqual({ cancelled: true, committed: false });
    expect(u.aborts.whisper).toBe(1);
    expect(onCancelled).toHaveBeenCalledWith(u.job);
    u.transcribe.finish();
    await u.done;
    expect(u.log).toEqual(["transcribe", "stopped after transcription"]);
  });

  it("before a pending note write: the write never starts", async () => {
    const u = runUtterance("RECORD");
    u.stop();
    u.transcribe.finish();
    await u.done;
    expect(u.log).not.toContain("note write started");
  });

  it("after the note write committed: the note is still saved (no rollback), but 'Saved.' is never spoken", async () => {
    const u = runUtterance("RECORD");
    u.transcribe.finish();
    await flush();
    expect(u.log).toContain("note write started");
    const { result } = u.stop();
    expect(result).toEqual({ cancelled: false, committed: true });
    u.write.finish();
    await u.done;
    expect(u.log).toEqual(["transcribe", "note write started", "note saved", "nothing spoken"]);
  });

  it("during answer generation: the LLM is stopped and the answer discarded", async () => {
    const u = runUtterance("ASK");
    u.transcribe.finish();
    await flush();
    expect(u.log).toContain("generate");
    const { result } = u.stop();
    expect(result.cancelled).toBe(true);
    expect(u.aborts.llm).toBe(1);
    u.generate.finish();
    await u.done;
    expect(u.log).toEqual(["transcribe", "generate", "answer discarded"]);
  });

  it("during speech: playback stops at once; the answer already in the history stays", async () => {
    const u = runUtterance("ASK");
    u.transcribe.finish();
    await flush();
    u.generate.finish();
    await flush();
    expect(u.log).toContain("speaking");
    const { stopSpeech } = u.stop(true);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    await u.done;
    expect(u.log).toContain("answer in history");
  });

  it("not speaking: Stop never touches speech it doesn't own", () => {
    const u = runUtterance("ASK");
    const { stopSpeech } = u.stop(false);
    expect(stopSpeech).not.toHaveBeenCalled();
  });

  it("Stop twice is harmless", async () => {
    const u = runUtterance("RECORD");
    expect(u.stop().result.cancelled).toBe(true);
    expect(u.stop().result.cancelled).toBe(false);
    expect(u.aborts.whisper).toBe(1);
  });
});

describe("ownership", () => {
  it("no Handsfree job in flight: an unrelated manual job is never cancelled", () => {
    const manual = new ProcessingJob();
    const onCancelled = jest.fn();
    const result = interruptHandsfreeWork({
      handsfreeJob: null,
      interrupted: new WeakSet(),
      isSpeaking: false,
      stopSpeech: jest.fn(),
      onCancelled,
    });
    expect(result).toEqual({ cancelled: false, committed: false });
    expect(manual.cancelled).toBe(false);
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("only the stopped job is marked: a later Handsfree job may still speak", () => {
    const interrupted = new WeakSet<ProcessingJob>();
    const stopped = new ProcessingJob();
    interruptHandsfreeWork({ handsfreeJob: stopped, interrupted, isSpeaking: false, stopSpeech: jest.fn() });
    const next = new ProcessingJob();
    expect(mayHandsfreeSpeak(stopped, interrupted)).toBe(false);
    expect(mayHandsfreeSpeak(next, interrupted)).toBe(true);
  });
});
