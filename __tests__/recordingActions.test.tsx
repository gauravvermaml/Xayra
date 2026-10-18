/**
 * Xayra 2.0 Stage 5a follow-up: when the emblem is hidden on a constrained
 * screen (360 x 760 at 200% text), its tap — the normal Finish — is gone,
 * so a compact Finish appears beside Cancel. Only then, only while a
 * manual recording is capturing.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const mockImpact = jest.fn(() => Promise.resolve());
jest.mock("expo-haptics", () => ({
  impactAsync: () => mockImpact(),
  ImpactFeedbackStyle: { Light: "light" },
}));
jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));

import { RecordingActions } from "../components/RecordingActions";
import { ManualUtteranceController, recordingActionsFor } from "../services/audio/manualUtterance";

const mounted: ReactTestRenderer[] = [];
afterEach(() => act(() => mounted.splice(0).forEach((t) => t.unmount())));

async function render(props: Parameters<typeof RecordingActions>[0]) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<RecordingActions {...props} />);
  });
  mounted.push(tree);
  return tree;
}

/** The Pressable for a test id (the node carrying onPress and hitSlop). */
const pressable = (tree: ReactTestRenderer, id: string) =>
  tree.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function")[0];

function controllerFor(processed: string[]) {
  return new ManualUtteranceController({
    startRecording: async () => true,
    stopRecording: async () => "file:///fake-cache/recordings/x.wav",
    discardRecording: async () => {},
    processUtterance: async (_u, mode, trigger) => {
      processed.push(`${mode}:${trigger}`);
    },
  });
}

describe("recordingActionsFor", () => {
  it("Finish only while capturing with the emblem hidden; Cancel whenever capturing", () => {
    expect(recordingActionsFor({ isCapturing: true, isHandsfreeActive: false, emblemHidden: false })).toEqual({
      cancel: true,
      finish: false,
    });
    expect(recordingActionsFor({ isCapturing: true, isHandsfreeActive: false, emblemHidden: true })).toEqual({
      cancel: true,
      finish: true,
    });
  });

  it("nothing when not capturing (idle, processing) or in Handsfree", () => {
    for (const emblemHidden of [false, true]) {
      expect(recordingActionsFor({ isCapturing: false, isHandsfreeActive: false, emblemHidden })).toEqual({
        cancel: false,
        finish: false,
      });
      expect(recordingActionsFor({ isCapturing: true, isHandsfreeActive: true, emblemHidden })).toEqual({
        cancel: false,
        finish: false,
      });
    }
  });
});

describe("RecordingActions", () => {
  it("emblem visible: Cancel only — the emblem stays the Finish", async () => {
    const tree = await render({ mode: "record", showFinish: false, onFinish: jest.fn(), onCancel: jest.fn() });
    expect(pressable(tree, "finish-recording")).toBeUndefined();
    expect(pressable(tree, "cancel-recording")).toBeDefined();
  });

  it("emblem hidden: Finish and Cancel, distinctly labelled, each a 48dp target", async () => {
    const tree = await render({ mode: "record", showFinish: true, onFinish: jest.fn(), onCancel: jest.fn() });
    const finish = pressable(tree, "finish-recording");
    const cancel = pressable(tree, "cancel-recording");
    expect(finish.props.accessibilityLabel).toBe("Finish recording. Stops listening and saves the note.");
    expect(cancel.props.accessibilityLabel).toBe("Cancel recording. Stops listening without saving.");
    for (const button of [finish, cancel]) {
      expect(button.props.accessibilityRole).toBe("button");
      expect(40 + 2 * button.props.hitSlop).toBeGreaterThanOrEqual(48);
    }
    const texts = tree.root.findAll((n) => typeof n.props.children === "string").map((n) => n.props.children);
    expect(texts).toEqual(expect.arrayContaining(["Finish", "Cancel"]));
  });

  it("Ask wording for an Ask recording", async () => {
    const tree = await render({ mode: "ask", showFinish: true, onFinish: jest.fn(), onCancel: jest.fn() });
    expect(pressable(tree, "finish-recording").props.accessibilityLabel).toBe(
      "Finish question. Stops listening and asks it."
    );
    expect(pressable(tree, "cancel-recording").props.accessibilityLabel).toBe(
      "Cancel question. Stops listening without asking."
    );
  });

  it("Finish runs the controller's own manual completion — once, even when tapped repeatedly", async () => {
    const processed: string[] = [];
    const controller = controllerFor(processed);
    await controller.start("record");
    const id = controller.utteranceId;
    const tree = await render({
      mode: "record",
      showFinish: true,
      onFinish: () => void controller.finish("tap", id),
      onCancel: () => void controller.cancel(id),
    });
    await act(async () => {
      pressable(tree, "finish-recording").props.onPress();
      pressable(tree, "finish-recording").props.onPress();
      pressable(tree, "cancel-recording").props.onPress();
    });
    expect(processed).toEqual(["record:tap"]);
    expect(controller.snapshot.phase).toBe("idle");
  });

  it("Cancel from the pair discards without processing, and a Finish after it does nothing", async () => {
    const processed: string[] = [];
    const controller = controllerFor(processed);
    await controller.start("ask");
    const id = controller.utteranceId;
    const tree = await render({
      mode: "ask",
      showFinish: true,
      onFinish: () => void controller.finish("tap", id),
      onCancel: () => void controller.cancel(id),
    });
    await act(async () => {
      pressable(tree, "cancel-recording").props.onPress();
      pressable(tree, "finish-recording").props.onPress();
    });
    expect(processed).toHaveLength(0);
    expect(controller.snapshot.phase).toBe("idle");
  });
});
