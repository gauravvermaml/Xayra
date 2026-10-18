/**
 * Xayra 2.0 Stage 2 multiline correction: the compose input never grows
 * under the keyboard. The tray doesn't move for the keyboard, so the input's
 * own cap is lowered to the measured space above it.
 *
 * Geometry below is from the Pixel 6 API 34 emulator (dp): field container
 * top 477.1 / keyboard top 577.9 on 411 x 914, 400.2 / 461.0 on 360 x 760;
 * the pure-calculation cases use the 1.0.43 input (one line 41.1 / 44.6 /
 * 55.2 dp at 100 / 130 / 200 % text). The ComposeBar cases use the Xayra 2.0
 * input: 16/22 type with 5dp explicit padding, so one line is 32dp at 100 %.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Keyboard, PixelRatio, TextInput, View } from "react-native";

jest.mock("@gorhom/bottom-sheet", () => {
  const { TextInput: RNTextInput } = jest.requireActual("react-native");
  return { BottomSheetTextInput: RNTextInput };
});

import { ComposeBar } from "../components/ComposeBar";
import { composeClearance } from "../utils/composeClearance";

const base = {
  containerPadding: 4,
  containerMinHeight: 40,
  margin: 8,
  lineHeight: 20,
  oneLineHeight: 41.1,
  maxLines: 5,
  maxHeight: 100,
};

describe("composeClearance", () => {
  it("keeps the normal maximum when there's room", () => {
    expect(composeClearance({ ...base, keyboardTop: 700, containerTop: 477.1 })).toEqual({
      lines: 5,
      maxHeight: 100,
      constrained: false,
      fits: true,
    });
  });

  it("411 x 914, 100 %: padding plus 3 whole lines", () => {
    // room 92.8 - 8 container padding - 21.1 input padding = 63.7 -> 3 lines
    const r = composeClearance({ ...base, keyboardTop: 577.9, containerTop: 477.1 });
    expect(r.lines).toBe(3);
    expect(r.maxHeight).toBeCloseTo(81.1, 5);
    expect(r).toMatchObject({ constrained: true, fits: true });
    // field bottom stays above the keyboard by at least the margin
    expect(477.1 + 4 + r.maxHeight + 4).toBeLessThanOrEqual(577.9 - 8);
  });

  it("360 x 760, 100 %: one line, no shorter than its natural height", () => {
    const r = composeClearance({ ...base, keyboardTop: 461, containerTop: 400.2 });
    expect(r).toMatchObject({ lines: 1, constrained: true, fits: true });
    expect(r.maxHeight).toBeCloseTo(41.1, 5);
  });

  it("360 x 760, 130 %: one line just fits", () => {
    const r = composeClearance({ ...base, lineHeight: 26, oneLineHeight: 44.6, keyboardTop: 461, containerTop: 400.2 });
    expect(r).toMatchObject({ lines: 1, fits: true });
    expect(r.maxHeight).toBeCloseTo(44.6, 5);
  });

  it("360 x 760, 200 %: even one line can't clear — stays one line, never shrinks", () => {
    const r = composeClearance({ ...base, lineHeight: 40, oneLineHeight: 55.2, keyboardTop: 461, containerTop: 400.2 });
    expect(r).toEqual({ lines: 1, maxHeight: 55.2, constrained: true, fits: false });
  });

  it("rounds down — never a partial line", () => {
    // inset 21.1; room needed for n lines = 8 + 21.1 + 20n (+ 8 margin)
    const at = (extra: number) =>
      composeClearance({ ...base, keyboardTop: 100 + 8 + 8 + 21.1 + extra, containerTop: 100 }).lines;
    expect(at(59.9)).toBe(2);
    expect(at(60.01)).toBe(3);
  });

  it("one-line fit boundary is the container's one-line height plus margin", () => {
    // one-line container = max(40, 41.1 + 8) = 49.1; + margin 8
    expect(composeClearance({ ...base, keyboardTop: 157.11, containerTop: 100 }).fits).toBe(true);
    expect(composeClearance({ ...base, keyboardTop: 157, containerTop: 100 }).fits).toBe(false);
  });

  it("keyboard above the field entirely: one line, not negative", () => {
    expect(composeClearance({ ...base, keyboardTop: 50, containerTop: 100 })).toEqual({
      lines: 1,
      maxHeight: 41.1,
      constrained: true,
      fits: false,
    });
  });
});

type KeyboardHandler = (e: { endCoordinates: { screenY: number } }) => void;

describe("ComposeBar under the keyboard", () => {
  let handlers: Record<string, KeyboardHandler>;
  let fieldTop: number;

  beforeEach(() => {
    jest.useFakeTimers();
    handlers = {};
    fieldTop = 400.2;
    jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, fn: KeyboardHandler) => {
      handlers[event] = fn;
      return { remove: () => delete handlers[event] };
    }) as unknown as typeof Keyboard.addListener);
    jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(1);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // jest-expo runs as iOS (keyboardWill*); Android uses keyboardDid*.
  const show: KeyboardHandler = (e) => handlers[Object.keys(handlers).find((k) => k.endsWith("Show"))!](e);
  const hide: KeyboardHandler = (e) => handlers[Object.keys(handlers).find((k) => k.endsWith("Hide"))!](e);
  const press = (tree: ReactTestRenderer) =>
    tree.root
      .findAll((n) => n.props.testID === "compose-submit" && typeof n.props.onPress === "function")[0]
      .props.onPress();
  const input = (tree: ReactTestRenderer) => tree.root.findByType(TextInput);
  const maxHeight = (tree: ReactTestRenderer) =>
    Object.assign({}, ...[input(tree).props.style].flat(Infinity).filter(Boolean)).maxHeight as number;
  const layoutInput = async (tree: ReactTestRenderer, height: number) =>
    act(async () => input(tree).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } }));

  async function renderBar(props: Partial<React.ComponentProps<typeof ComposeBar>> = {}) {
    const onSubmit = jest.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <ComposeBar
          inputText="hello"
          onInputChange={() => {}}
          onInputFocus={() => {}}
          onInputBlur={() => {}}
          onSubmit={onSubmit}
          placeholder="Type your thoughts..."
          mode="record"
          {...props}
        />,
      );
    });
    // jest-expo's View is a mock class instance (createNodeMock doesn't
    // apply), so the window measurement is stubbed on the instance itself.
    const field = tree.root.findAll((n) => n.props.testID === "compose-field" && n.instance)[0];
    field.instance.measureInWindow = (cb: (x: number, y: number, w: number, h: number) => void) =>
      cb(16, fieldTop, 379, 49);
    return { tree, onSubmit };
  }

  it("defaults to 5 lines (5 x 22 + padding = 120 dp) with no keyboard", async () => {
    const { tree } = await renderBar();
    expect(input(tree).props.numberOfLines).toBe(5);
    expect(maxHeight(tree)).toBe(120);
    expect(input(tree).props.multiline).toBe(true);
    expect(input(tree).props.textAlignVertical).toBe("top");
    const bar = tree.root
      .findAllByType(View)
      .find((v) =>
        [v.props.style].flat().some((s) => s?.minHeight === 48 && s?.paddingVertical === 4 && s?.alignItems === "center"),
      );
    expect(bar).toBeDefined();
  });

  it("lowers the cap to the measured space, then restores it when the keyboard closes", async () => {
    fieldTop = 477.1;
    const { tree } = await renderBar();
    await layoutInput(tree, 32);
    await act(async () => show({ endCoordinates: { screenY: 577.9 } }));
    // room 92.8 - 8 container padding - 10 input padding = 74.8 -> 3 lines of 22
    expect(input(tree).props.numberOfLines).toBe(3);
    expect(maxHeight(tree)).toBeCloseTo(76, 5);

    await act(async () => hide({ endCoordinates: { screenY: 914 } }));
    expect(input(tree).props.numberOfLines).toBe(5);
    expect(maxHeight(tree)).toBe(120);
  });

  it("uses the smallest laid-out height as the one-line height", async () => {
    const { tree } = await renderBar();
    await layoutInput(tree, 81.1); // laid out with several lines first
    await layoutInput(tree, 41.1); // then one line
    await layoutInput(tree, 61.1);
    await act(async () => show({ endCoordinates: { screenY: 461 } }));
    expect(maxHeight(tree)).toBeCloseTo(41.1, 5);
  });

  it("re-measures once the focus snap settles", async () => {
    const { tree } = await renderBar();
    await layoutInput(tree, 32);
    fieldTop = 520; // sheet still rising when the keyboard reports shown
    await act(async () => show({ endCoordinates: { screenY: 577.9 } }));
    expect(input(tree).props.numberOfLines).toBe(1);
    fieldTop = 477.1; // settled at 50%
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(input(tree).props.numberOfLines).toBe(3);
  });

  it("re-learns the one-line height when the font scale changes", async () => {
    const { tree } = await renderBar();
    await layoutInput(tree, 41.1);
    (PixelRatio.getFontScale as jest.Mock).mockReturnValue(1.3);
    await layoutInput(tree, 44.6);
    await act(async () => show({ endCoordinates: { screenY: 461 } }));
    expect(maxHeight(tree)).toBeCloseTo(44.6, 5);
  });

  it("never shrinks below one line when space is insufficient (200 %, 360 x 760)", async () => {
    (PixelRatio.getFontScale as jest.Mock).mockReturnValue(2);
    const { tree } = await renderBar();
    await layoutInput(tree, 55.2);
    await act(async () => show({ endCoordinates: { screenY: 461 } }));
    expect(input(tree).props.numberOfLines).toBe(1);
    expect(maxHeight(tree)).toBeCloseTo(55.2, 5);
  });

  it("uses the real rendered line height from the probe (Android's nonlinear font scaling)", async () => {
    (PixelRatio.getFontScale as jest.Mock).mockReturnValue(2);
    fieldTop = 477.1;
    const { tree } = await renderBar();
    await layoutInput(tree, 45.3);
    // Without the probe, 22 x 2 = 44 per line leaves room for only one line.
    await act(async () => show({ endCoordinates: { screenY: 577.9 } }));
    expect(input(tree).props.numberOfLines).toBe(1);
    // The probe reports what Android actually renders at 200 %: 35dp lines.
    const probe = tree.root.findAll((n) => typeof n.props.onTextLayout === "function")[0];
    await act(async () =>
      probe.props.onTextLayout({ nativeEvent: { lines: [{ y: 0, height: 35 }, { y: 35, height: 35 }] } })
    );
    await act(async () => show({ endCoordinates: { screenY: 577.9 } }));
    // room 92.8 - 8 - (45.3 - 35) = 74.5 -> 2 lines of 35
    expect(input(tree).props.numberOfLines).toBe(2);
    expect(maxHeight(tree)).toBeCloseTo(80.3, 5);
  });

  it("measures again when the tray moves to another stage with the keyboard up", async () => {
    fieldTop = 477.1;
    const props = {
      inputText: "hello",
      onInputChange: () => {},
      onInputFocus: () => {},
      onInputBlur: () => {},
      onSubmit: jest.fn(),
      placeholder: "Type your thoughts…",
      mode: "record" as const,
    };
    const { tree } = await renderBar({ sheetIndex: 1 });
    await layoutInput(tree, 32);
    await act(async () => show({ endCoordinates: { screenY: 577.9 } }));
    expect(input(tree).props.numberOfLines).toBe(3);
    fieldTop = 520; // dragged lower while typing
    await act(async () => tree.update(<ComposeBar {...props} sheetIndex={0} />));
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(input(tree).props.numberOfLines).toBe(1);
  });

  it("doesn't re-render for a repeat show event with the same result", async () => {
    const { tree } = await renderBar();
    await layoutInput(tree, 41.1);
    await act(async () => show({ endCoordinates: { screenY: 461 } }));
    const capped = input(tree).props;
    await act(async () => show({ endCoordinates: { screenY: 461 } }));
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(input(tree).props).toBe(capped);
  });

  it("layout changes alone never change the cap (no measurement loop)", async () => {
    const { tree } = await renderBar();
    const before = input(tree).props;
    await layoutInput(tree, 41.1);
    await layoutInput(tree, 100);
    expect(input(tree).props).toBe(before);
  });

  it("Enter inserts a newline: no submit on the return key", async () => {
    const { tree, onSubmit } = await renderBar();
    expect(input(tree).props.returnKeyType).toBeUndefined();
    expect(input(tree).props.onSubmitEditing).toBeUndefined();
    expect(input(tree).props.blurOnSubmit).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("the arrow submits once; a double tap doesn't submit twice", async () => {
    const { tree, onSubmit } = await renderBar();
    await act(async () => {
      press(tree);
      press(tree);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  it("typed Record keeps the keyboard; typed Ask dismisses it", async () => {
    const rec = await renderBar({ mode: "record" });
    await act(async () => press(rec.tree));
    expect(Keyboard.dismiss).not.toHaveBeenCalled();

    const ask = await renderBar({ mode: "ask" });
    await act(async () => press(ask.tree));
    expect(Keyboard.dismiss).toHaveBeenCalledTimes(1);
  });

  it("removes its keyboard listeners on unmount", async () => {
    const { tree } = await renderBar();
    expect(Object.keys(handlers)).toHaveLength(2);
    await act(async () => tree.unmount());
    expect(Object.keys(handlers)).toEqual([]);
  });
});
