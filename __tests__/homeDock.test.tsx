/**
 * Xayra 2.0 Stage 4: the bottom dock and the Handsfree typing status are
 * presentational — they show the existing controller's state and call the
 * home screen's existing handlers.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PixelRatio, Text } from "react-native";

import { HandsfreeTypingStatus } from "../components/HandsfreeTypingStatus";
import { dockLayout, HomeDock, type HomeDockProps } from "../components/HomeDock";

const mounted: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => mounted.splice(0).forEach((tree) => tree.unmount()));
  jest.restoreAllMocks();
});

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(element);
  });
  mounted.push(tree);
  return tree;
}

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((t) => [t.props.children].flat().join(""));
const byTestId = (tree: ReactTestRenderer, id: string) =>
  tree.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function")[0];

function dockProps(overrides: Partial<HomeDockProps> = {}): HomeDockProps {
  return {
    handsfreeActive: false,
    handsfreeState: "idle",
    pendingCount: 0,
    bottomInset: 24,
    onHandsfree: jest.fn(),
    onTodos: jest.fn(),
    onMore: jest.fn(),
    onHeightChange: jest.fn(),
    ...overrides,
  };
}

describe("HomeDock", () => {
  it("shows Handsfree, To-Dos and More, and calls the existing handlers", async () => {
    const props = dockProps();
    const tree = await render(<HomeDock {...props} />);
    expect(texts(tree)).toEqual(expect.arrayContaining(["Handsfree", "To-Dos", "More"]));
    await act(async () => byTestId(tree, "dock-handsfree").props.onPress());
    await act(async () => byTestId(tree, "dock-todos").props.onPress());
    await act(async () => byTestId(tree, "dock-more").props.onPress());
    expect(props.onHandsfree).toHaveBeenCalledTimes(1);
    expect(props.onTodos).toHaveBeenCalledTimes(1);
    expect(props.onMore).toHaveBeenCalledTimes(1);
  });

  it("shows the real pending count, spoken in the To-Dos label", async () => {
    const tree = await render(<HomeDock {...dockProps({ pendingCount: 3 })} />);
    expect(texts(tree)).toContain("3");
    expect(byTestId(tree, "dock-todos").props.accessibilityLabel).toBe("To-Dos, 3 pending");
    const none = await render(<HomeDock {...dockProps({ pendingCount: 0 })} />);
    expect(byTestId(none, "dock-todos").props.accessibilityLabel).toBe("To-Dos");
  });

  it.each([
    ["listening", "Handsfree · listening"],
    ["processing", "Handsfree · processing"],
    ["speaking", "Handsfree · speaking"],
  ] as const)("active Handsfree shows its actual state (%s) as a checked switch", async (state, label) => {
    const tree = await render(<HomeDock {...dockProps({ handsfreeActive: true, handsfreeState: state })} />);
    expect(texts(tree)).toContain(label);
    const toggle = byTestId(tree, "dock-handsfree");
    expect(toggle.props.accessibilityRole).toBe("switch");
    expect(toggle.props.accessibilityState).toEqual({ checked: true });
  });

  it("adds the bottom safe-area inset once, inside the dock, and reports its height", async () => {
    const props = dockProps({ bottomInset: 48 });
    const tree = await render(<HomeDock {...props} />);
    const wrap = tree.root.findAll((n) => n.props.testID === "home-dock" && typeof n.props.onLayout === "function")[0];
    const style = [wrap.props.style].flat().reduce((a, b) => ({ ...a, ...b }), {});
    expect(style.paddingBottom).toBe(48 + 8);
    await act(async () => wrap.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 411, height: 123.6 } } }));
    expect(props.onHeightChange).toHaveBeenCalledWith(124);
  });

  it("picks its layout from width and text size, never by shrinking text", () => {
    expect(dockLayout(411, 1)).toBe("inline");
    expect(dockLayout(360, 1)).toBe("stacked");
    expect(dockLayout(411, 1.3)).toBe("stacked");
    expect(dockLayout(360, 1.3)).toBe("rows");
    expect(dockLayout(360, 1.2999999523)).toBe("rows"); // how Android reports 130 %
    expect(dockLayout(411, 2)).toBe("rows");
  });

  it("stacked: labels under icons, the count badge on the icon, labels may wrap", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(1.2);
    const tree = await render(<HomeDock {...dockProps({ pendingCount: 2 })} />);
    const item = byTestId(tree, "dock-todos");
    const style = [item.props.style({ pressed: false })].flat(Infinity).filter(Boolean).reduce((a, b) => ({ ...a, ...b }), {});
    expect(style.flexDirection).toBe("column");
    const labels = tree.root.findAllByType(Text).filter((t) => t.props.numberOfLines === 2);
    expect(labels.length).toBeGreaterThanOrEqual(3);
  });

  it("rows (very large text): Handsfree spans the first row", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2);
    const tree = await render(<HomeDock {...dockProps()} />);
    const hf = byTestId(tree, "dock-handsfree");
    const style = [hf.props.style({ pressed: false })].flat(Infinity).filter(Boolean).reduce((a, b) => ({ ...a, ...b }), {});
    expect(style.flexBasis).toBe("100%");
  });
});

describe("HandsfreeTypingStatus", () => {
  it("shows the actual state and a labelled Stop that calls the controller's stop", async () => {
    const onStop = jest.fn();
    const tree = await render(<HandsfreeTypingStatus state="processing" onStop={onStop} />);
    expect(texts(tree)).toContain("Handsfree · processing");
    const stop = byTestId(tree, "handsfree-typing-stop");
    expect(stop.props.accessibilityRole).toBe("button");
    expect(stop.props.accessibilityLabel).toBe("Stop Handsfree");
    // 40dp visible + 4dp slop on each side = a 48dp target
    expect(stop.props.hitSlop).toBe(4);
    await act(async () => stop.props.onPress());
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
