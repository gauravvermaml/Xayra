/**
 * Xayra 2.0 Stage 5c: Android Back on the home screen closes the topmost
 * open thing first, the listener lives exactly as long as the screen's
 * focus, and the full-screen view's Collapse settles back to the 50% tray.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { BackHandler, Dimensions, PixelRatio, Text } from "react-native";

let mockFocusCleanup: (() => void) | undefined;
jest.mock("expo-router", () => {
  const React = jest.requireActual("react");
  return {
    // Runs the focus effect on mount (focus) and its cleanup on unmount
    // (blur), like a screen that gains and then loses focus.
    useFocusEffect: (effect: () => (() => void) | undefined) => {
      React.useEffect(() => {
        mockFocusCleanup = effect() ?? undefined;
        return () => mockFocusCleanup?.();
      }, []);
    },
  };
});
jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => {
  const actual = require("react-native-reanimated/mock");
  // withSpring settles straight to its target, so the end state is visible.
  return { ...actual, withSpring: (to: number) => to };
});
jest.mock("react-native-gesture-handler", () => {
  const { View } = jest.requireActual("react-native");
  const chain: Record<string, () => unknown> = {};
  for (const name of ["onStart", "onUpdate", "onEnd", "manualActivation", "onTouchesDown", "onTouchesMove"]) chain[name] = () => chain;
  return { Gesture: { Pan: () => chain }, GestureDetector: ({ children }: { children: React.ReactNode }) => children, View };
});

import { decideHomeBack, type HomeBackState } from "../utils/backNavigation";
import { useHardwareBack } from "../hooks/useHardwareBack";
import { ExpandedTextOverlay } from "../components/ExpandedTextOverlay";

const none: HomeBackState = {
  quickMenuOpen: false,
  todosOpen: false,
  fullScreenOpen: false,
  composing: false,
  trayRaised: false,
};

describe("Back precedence (decideHomeBack)", () => {
  it("resting home with nothing open: Android's own Back (no trap)", () => {
    expect(decideHomeBack(none)).toBe("system");
  });

  it.each([
    [{ quickMenuOpen: true }, "close-quick-menu"],
    [{ todosOpen: true }, "todos"],
    [{ fullScreenOpen: true }, "collapse-full-screen"],
    [{ composing: true }, "end-composing"],
    [{ trayRaised: true }, "collapse-tray"],
  ] as const)("%o alone → %s", (open, action) => {
    expect(decideHomeBack({ ...none, ...open })).toBe(action);
  });

  it("the topmost wins when several could be open", () => {
    const all: HomeBackState = {
      quickMenuOpen: true,
      todosOpen: true,
      fullScreenOpen: true,
      composing: true,
      trayRaised: true,
    };
    expect(decideHomeBack(all)).toBe("close-quick-menu");
    expect(decideHomeBack({ ...all, quickMenuOpen: false })).toBe("todos");
    expect(decideHomeBack({ ...all, quickMenuOpen: false, todosOpen: false })).toBe("collapse-full-screen");
    expect(decideHomeBack({ ...all, quickMenuOpen: false, todosOpen: false, fullScreenOpen: false })).toBe(
      "end-composing"
    );
    expect(decideHomeBack({ ...none, trayRaised: true, composing: true })).toBe("end-composing");
  });

  it("repeated Back presses walk down one level at a time, then hand Back to Android", () => {
    // Full-screen sits over the 50% tray, with a still-focused field.
    let state: HomeBackState = { ...none, fullScreenOpen: true, composing: true, trayRaised: true };
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const action = decideHomeBack(state);
      seen.push(action);
      if (action === "collapse-full-screen") state = { ...state, fullScreenOpen: false };
      if (action === "end-composing") state = { ...state, composing: false };
      if (action === "collapse-tray") state = { ...state, trayRaised: false };
    }
    expect(seen).toEqual(["collapse-full-screen", "end-composing", "collapse-tray", "system", "system"]);
  });

  it("a Back while the tray is still settling to rest collapses again instead of leaving", () => {
    // sheetIndex only changes when the snap settles: mid-animation it still reads raised.
    const midSettle: HomeBackState = { ...none, trayRaised: true };
    expect(decideHomeBack(midSettle)).toBe("collapse-tray");
    expect(decideHomeBack(midSettle)).toBe("collapse-tray");
  });
});

describe("useHardwareBack listener lifecycle", () => {
  const addSpy = () => jest.spyOn(BackHandler, "addEventListener");

  function Screen({ handler }: { handler: () => boolean }) {
    useHardwareBack(handler);
    return null;
  }

  it("one listener for the focus, never one per render; removed on blur", async () => {
    const spy = addSpy();
    const remove = jest.fn();
    spy.mockImplementation(() => ({ remove }) as never);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Screen handler={() => true} />);
    });
    await act(async () => tree.update(<Screen handler={() => false} />));
    await act(async () => tree.update(<Screen handler={() => true} />));
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
    expect(remove).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("always calls the latest handler (no stale state)", async () => {
    const spy = addSpy();
    let listener!: () => boolean;
    spy.mockImplementation((_event, l) => {
      listener = l as () => boolean;
      return { remove: jest.fn() } as never;
    });
    const first = jest.fn(() => true);
    const latest = jest.fn(() => false);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Screen handler={first} />);
    });
    await act(async () => tree.update(<Screen handler={latest} />));
    expect(listener()).toBe(false);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    act(() => tree.unmount());
    spy.mockRestore();
  });
});

describe("full-screen Collapse", () => {
  async function renderOverlay(progressValue: number) {
    const progress = { value: progressValue } as never as { value: number };
    const onSettle = jest.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <ExpandedTextOverlay topInset={24} bottomInset={24} progress={progress as never} dragDistance={274} onSettle={onSettle} listScrollOffset={{ value: 0 } as never}>
          {null}
        </ExpandedTextOverlay>
      );
    });
    return { tree, progress, onSettle };
  }
  const collapseButton = (tree: ReactTestRenderer) =>
    tree.root.findAll((n) => n.props.testID === "full-screen-collapse" && typeof n.props.onPress === "function")[0];

  it("settles back to the 50% tray through the same settle as a drag release", async () => {
    const { tree, progress, onSettle } = await renderOverlay(1);
    act(() => collapseButton(tree).props.onPress());
    expect(progress.value).toBe(0);
    expect(onSettle).toHaveBeenCalledWith(false);
    act(() => tree.unmount());
  });

  it("is a labelled button with a hint and a 48dp target", async () => {
    const { tree } = await renderOverlay(1);
    const button = collapseButton(tree);
    expect(button.props.accessibilityRole).toBe("button");
    expect(button.props.accessibilityLabel).toBe("Collapse");
    expect(button.props.accessibilityHint).toBe("Returns to the half-height tray");
    expect(40 + 2 * button.props.hitSlop).toBeGreaterThanOrEqual(48);
    act(() => tree.unmount());
  });

  it("narrow screen at 200% text: the chevron alone (no wide label into the handle), same label and target", async () => {
    const dims = jest
      .spyOn(Dimensions, "get")
      .mockReturnValue({ width: 360, height: 760, scale: 2.625, fontScale: 2 } as never);
    const font = jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2);
    const { tree } = await renderOverlay(1);
    const button = collapseButton(tree);
    // (the chevron icon itself renders as a glyph Text, so look for the word)
    expect(button.findAll((n) => n.type === Text && n.props.children === "Collapse")).toHaveLength(0);
    expect(button.props.accessibilityLabel).toBe("Collapse");
    expect(40 + 2 * button.props.hitSlop).toBeGreaterThanOrEqual(48);
    act(() => tree.unmount());
    dims.mockRestore();
    font.mockRestore();
  });

  it("wider screen or smaller text: the word stays", async () => {
    const font = jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(1.3);
    const { tree } = await renderOverlay(1);
    expect(collapseButton(tree).findAll((n) => n.type === Text && n.props.children === "Collapse")).toHaveLength(1);
    act(() => tree.unmount());
    font.mockRestore();
  });

  it("while collapsed the overlay is hidden from TalkBack and takes no touches", async () => {
    const { tree } = await renderOverlay(0);
    const root = tree.root.findAll((n) => n.props.importantForAccessibility !== undefined && n.props.pointerEvents !== undefined)[0];
    expect(root.props.pointerEvents).toBe("none");
    expect(root.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(root.props.accessibilityElementsHidden).toBe(true);
    act(() => tree.unmount());
  });
});
