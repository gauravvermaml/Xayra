/**
 * Xayra 2.0 Stage 5d: after To-Dos closes by hardware Back the compose field
 * is briefly non-editable (so Android can't push focus into it), but a real
 * touch on it ends that guard and focuses it — a quick tap is never lost.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const mockFocus = jest.fn();
jest.mock("@gorhom/bottom-sheet", () => {
  const React = jest.requireActual("react");
  const { TextInput } = jest.requireActual("react-native");
  const Input = React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    React.useImperativeHandle(ref, () => ({ focus: mockFocus }));
    return <TextInput {...props} />;
  });
  return { BottomSheetTextInput: Input };
});

import { ComposeBar } from "../components/ComposeBar";

const base = {
  inputText: "",
  onInputChange: jest.fn(),
  onInputFocus: jest.fn(),
  onInputBlur: jest.fn(),
  onSubmit: jest.fn(),
  placeholder: "Type your thoughts…",
  mode: "record" as const,
};

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(element);
  });
  return tree;
}
const field = (tree: ReactTestRenderer) => tree.root.findAll((n) => n.props.testID === "compose-field" && n.props.onTouchStart)[0];
const input = (tree: ReactTestRenderer) => tree.root.findAll((n) => n.props.editable !== undefined)[0];

beforeEach(() => mockFocus.mockClear());

describe("compose guard", () => {
  it("covered: not editable", async () => {
    const tree = await render(<ComposeBar {...base} covered />);
    expect(input(tree).props.editable).toBe(false);
    act(() => tree.unmount());
  });

  it("a touch while covered ends the guard, and the field focuses as soon as it's editable", async () => {
    const onCoveredTouch = jest.fn();
    const tree = await render(<ComposeBar {...base} covered onCoveredTouch={onCoveredTouch} />);
    act(() => field(tree).props.onTouchStart());
    expect(onCoveredTouch).toHaveBeenCalledTimes(1);
    expect(mockFocus).not.toHaveBeenCalled();
    await act(async () => tree.update(<ComposeBar {...base} covered={false} onCoveredTouch={onCoveredTouch} />));
    expect(input(tree).props.editable).toBe(true);
    expect(mockFocus).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it("the guard ending on its own (no touch) never steals focus", async () => {
    const tree = await render(<ComposeBar {...base} covered onCoveredTouch={jest.fn()} />);
    await act(async () => tree.update(<ComposeBar {...base} covered={false} onCoveredTouch={jest.fn()} />));
    expect(mockFocus).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it("not covered: a touch is the field's own business (no guard call)", async () => {
    const onCoveredTouch = jest.fn();
    const tree = await render(<ComposeBar {...base} onCoveredTouch={onCoveredTouch} />);
    act(() => field(tree).props.onTouchStart());
    expect(onCoveredTouch).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
