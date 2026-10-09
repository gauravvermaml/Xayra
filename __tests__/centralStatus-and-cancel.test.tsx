/**
 * The central button's status line after capture ends, and the Cancel
 * action's press feedback.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const mockImpact = jest.fn(() => Promise.resolve());
jest.mock("expo-haptics", () => ({
  impactAsync: () => mockImpact(),
  ImpactFeedbackStyle: { Light: "light" },
}));
// Reanimated's worklet runtime is native-only; its official Jest mock
// renders the same component tree with plain values.
jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
jest.mock("../services/ai/localWhisper", () => ({ cancelActiveTranscription: jest.fn() }));
jest.mock("../services/ai/localLlama", () => ({ cancelActiveLlamaCompletion: jest.fn() }));

import { CancelProcessingButton } from "../components/CancelProcessingButton";
import { PIPELINE_STAGE_LABELS, type PipelineStage } from "../services/ai/pipelineStage";
import { ACKNOWLEDGED_STATUS, LISTENING_STATUS, centralStatusText } from "../services/audio/manualUtterance";

jest.setTimeout(30_000);

type Step = { phase: "recording" | "stopping" | "processing" | "idle"; stage?: PipelineStage | null };
const run = (steps: Step[], isHandsfreeActive = false) =>
  steps.map((s) => centralStatusText({ phase: s.phase, pipelineStage: s.stage ?? null, isHandsfreeActive }));

describe("status line after capture ends", () => {
  it("Ask: listening → got it → looking through notes → piecing it together", () => {
    // The real order: capture, recorder drain, transcription (index.tsx),
    // retrieval and generation (rag.ts), rag's own clear, pipeline unwind.
    const shown = run([
      { phase: "recording" },
      { phase: "stopping" },
      { phase: "processing", stage: "transcribing" },
      { phase: "processing", stage: "retrieving" },
      { phase: "processing", stage: "answering" },
      { phase: "processing", stage: null },
      { phase: "idle" },
    ]);
    expect(shown).toEqual([
      LISTENING_STATUS,
      "Got it",
      "Got it",
      "Reading through your notes",
      "Piecing it together",
      "Got it",
      null,
    ]);
  });

  it("Record: listening → got it → the real embed/save stages", () => {
    const shown = run([
      { phase: "recording" },
      { phase: "stopping" },
      { phase: "processing", stage: "transcribing" },
      { phase: "processing", stage: "understanding" },
      { phase: "processing", stage: "saving" },
      { phase: "processing", stage: null },
      { phase: "idle" },
    ]);
    expect(shown).toEqual([
      LISTENING_STATUS,
      "Got it",
      "Got it",
      "Finding where this belongs",
      "Tucked away safely",
      "Got it",
      null,
    ]);
  });

  it("never says Xayra is still hearing or listening once recording has ended", () => {
    const stages: (PipelineStage | null)[] = [null, ...(Object.keys(PIPELINE_STAGE_LABELS) as PipelineStage[])];
    for (const phase of ["stopping", "processing"] as const) {
      for (const stage of stages) {
        for (const isHandsfreeActive of [false, true]) {
          const text = centralStatusText({ phase, pipelineStage: stage, isHandsfreeActive }) ?? "";
          expect(text).not.toMatch(/hearing|listening/i);
        }
      }
    }
    expect(Object.values(PIPELINE_STAGE_LABELS)).not.toContain("Hearing you out");
  });

  it("acknowledges straight away while the recorder drains, even if a stale stage is set", () => {
    expect(centralStatusText({ phase: "stopping", pipelineStage: "answering", isHandsfreeActive: false })).toBe(
      ACKNOWLEDGED_STATUS
    );
  });

  it("keeps Handsfree's 'tap to cancel' hint", () => {
    expect(centralStatusText({ phase: "processing", pipelineStage: "retrieving", isHandsfreeActive: true })).toBe(
      "Reading through your notes · tap to cancel"
    );
  });
});

describe("Cancel press feedback", () => {
  async function render(onCancel: () => void): Promise<ReactTestRenderer> {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<CancelProcessingButton onCancel={onCancel} />);
    });
    return tree;
  }

  it("gives a light haptic the moment it's pressed down", async () => {
    const onCancel = jest.fn();
    const tree = await render(onCancel);
    const button = tree.root.findByProps({ testID: "cancel-processing" });
    act(() => button.props.onPressIn());
    expect(mockImpact).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    act(() => button.props.onPressOut());
  });

  it("cancels on press immediately, without waiting for the animation", async () => {
    const onCancel = jest.fn();
    const tree = await render(onCancel);
    const button = tree.root.findByProps({ testID: "cancel-processing" });
    act(() => {
      button.props.onPressIn();
      button.props.onPress();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => button.props.onPressOut());
  });

  it("is labelled and exposed as a button", async () => {
    const tree = await render(jest.fn());
    const button = tree.root.findByProps({ testID: "cancel-processing" });
    expect(button.props.accessibilityRole).toBe("button");
    expect(button.props.accessibilityLabel).toBe("Cancel");
  });
});
