/**
 * QA Phase 3 (qa/05-consolidated-triage.md P2-2): pipelineStage.ts used to
 * be one shared module-level value for the whole app, so a note save
 * (services/notes/noteManager.ts, "note" flow) and a chat query
 * (services/ai/rag.ts, "chat" flow) running back-to-back could overwrite
 * each other's status label — whichever screen re-rendered next would show
 * the WRONG flow's stage. Locks in that the two flows are now fully
 * independent: a write to one never reaches a listener subscribed to the
 * other, and each flow's own "current stage" is readable/gettable on its own.
 */
import { getPipelineStage, setPipelineStage, subscribeToPipelineStage } from "../services/ai/pipelineStage";

describe("pipelineStage flow isolation (Phase 3 P2-2)", () => {
  afterEach(() => {
    // Leave both flows clean for the next test — these are real module-level
    // globals, not reset automatically between tests in the same file.
    setPipelineStage("note", null);
    setPipelineStage("chat", null);
  });

  it("a write to the note flow does not notify a chat-flow listener, and vice versa", () => {
    const noteListener = jest.fn();
    const chatListener = jest.fn();
    const unsubscribeNote = subscribeToPipelineStage("note", noteListener);
    const unsubscribeChat = subscribeToPipelineStage("chat", chatListener);

    setPipelineStage("note", "understanding");
    expect(noteListener).toHaveBeenCalledWith("understanding");
    expect(chatListener).not.toHaveBeenCalled();

    setPipelineStage("chat", "retrieving");
    expect(chatListener).toHaveBeenCalledWith("retrieving");
    // Still exactly one call — the chat write didn't also reach the note
    // listener.
    expect(noteListener).toHaveBeenCalledTimes(1);

    unsubscribeNote();
    unsubscribeChat();
  });

  it("the exact race the bug describes: a note-save write followed by a chat-query write leaves each flow's own stage correct", () => {
    // Simulates a voice note mid-save ("understanding") and a typed chat
    // query starting ("retrieving") landing back-to-back — the scenario
    // that, before this fix, left one shared `current` value reflecting
    // only whichever call happened last, regardless of which screen a
    // reader actually cared about.
    setPipelineStage("note", "understanding");
    setPipelineStage("chat", "retrieving");

    expect(getPipelineStage("note")).toBe("understanding");
    expect(getPipelineStage("chat")).toBe("retrieving");

    // The note flow finishing and clearing itself must not touch the
    // still-in-flight chat flow.
    setPipelineStage("note", null);
    expect(getPipelineStage("note")).toBeNull();
    expect(getPipelineStage("chat")).toBe("retrieving");
  });

  it("unsubscribing stops further notifications for that flow only", () => {
    const noteListener = jest.fn();
    const unsubscribe = subscribeToPipelineStage("note", noteListener);
    setPipelineStage("note", "saving");
    expect(noteListener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setPipelineStage("note", "understanding");
    expect(noteListener).toHaveBeenCalledTimes(1);
  });
});
