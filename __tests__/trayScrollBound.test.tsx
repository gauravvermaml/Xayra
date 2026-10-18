/**
 * Xayra 2.0 Stage 4.2: the tray's list scrolls at 50% only if it is laid out
 * inside a bounded height. gorhom's own bound is an animated style that never
 * reaches layout on this stack, so HistorySheet wraps its children in a
 * static box: half the window (gorhom's "50%") minus the handle. Without it
 * the list lays out at its full content height and has nothing to scroll.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Dimensions, Text, View } from "react-native";

jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
jest.mock("@gorhom/bottom-sheet", () => {
  const React = jest.requireActual("react");
  const { View: RNView } = jest.requireActual("react-native");
  const Sheet = React.forwardRef((props: { children: React.ReactNode }, _ref: unknown) => (
    <RNView testID="gorhom-sheet">{props.children}</RNView>
  ));
  return { __esModule: true, default: Sheet, BottomSheetFooter: RNView };
});
jest.mock("../components/useExpandOverdragGestureHandlers", () => ({
  createExpandOverdragGestureHandlersHook: () => () => ({}),
}));
jest.mock("../components/ModelDownloadCard", () => ({ ModelDownloadCard: () => null }));
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn() }));

import { HistorySheet, SHEET_HANDLE_HEIGHT } from "../components/HistorySheet";

const sharedValue = (value: number) => ({ value, get: () => value, set: jest.fn() }) as never;

async function renderSheet(sheetIndex: number): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <HistorySheet
        composeBarSlot={<Text>field</Text>}
        content={<View testID="tray-list" />}
        animatedIndex={sharedValue(sheetIndex)}
        sheetIndex={sheetIndex}
        modelDownload={{ status: "ready" } as never}
        bottomInset={24}
        restHeight={180}
        footer={<Text>dock</Text>}
        footerHeight={90}
        footerYieldsAtHalf={false}
        onHeaderLayout={jest.fn()}
        expandProgress={sharedValue(0)}
        expandDragDistance={300}
        onExpandSettle={jest.fn()}
      />
    );
  });
  return tree;
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

describe("tray content bound (list scrolling at 50%)", () => {
  it("wraps the field and list in a static box: half the window minus the handle", async () => {
    const tree = await renderSheet(1);
    const sheet = tree.root.findByProps({ testID: "gorhom-sheet" });
    const wrapper = sheet.findAllByType(View).find((v) => v !== sheet && flat(v.props.style).height !== undefined)!;
    const expected = Dimensions.get("window").height * 0.5 - SHEET_HANDLE_HEIGHT;
    expect(flat(wrapper.props.style).height).toBe(expected);
    // The list lives inside the bound, so its viewport can't grow to its content.
    expect(wrapper.findAllByProps({ testID: "tray-list" }).length).toBeGreaterThan(0);
    await act(async () => tree.unmount());
  });

  it("keeps the same bound at rest (the body is hidden there, the field stays on top)", async () => {
    const tree = await renderSheet(0);
    const sheet = tree.root.findByProps({ testID: "gorhom-sheet" });
    const wrapper = sheet.findAllByType(View).find((v) => v !== sheet && flat(v.props.style).height !== undefined)!;
    expect(flat(wrapper.props.style).height).toBe(Dimensions.get("window").height * 0.5 - SHEET_HANDLE_HEIGHT);
    await act(async () => tree.unmount());
  });
});
