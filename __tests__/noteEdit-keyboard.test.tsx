/**
 * Note edit keyboard avoidance: the sheet lifts by exactly the height the
 * keyboard covers, Save/Cancel stay reachable, and it settles back when the
 * keyboard goes away.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Keyboard, StyleSheet, TextInput, View } from "react-native";
import { useRef } from "react";

const mockGetNoteById = jest.fn();
const mockUpdateNoteText = jest.fn((_id: string, _text: string) => Promise.resolve());
const mockDeleteNote = jest.fn((_id: string) => Promise.resolve());
jest.mock("../services/notes/noteManager", () => ({
  getNoteById: (id: string) => mockGetNoteById(id),
  updateNoteText: (id: string, text: string) => mockUpdateNoteText(id, text),
  deleteNote: (id: string) => mockDeleteNote(id),
}));
jest.mock("../services/audio/player", () => ({ useAudioPlayerControls: () => ({ pause: jest.fn() }) }));
jest.mock("../components/AudioPlayerControls", () => ({ AudioPlayerControls: () => null }));
jest.mock("../utils/clipboard", () => ({ copyTextWithFeedback: jest.fn() }));

import { NoteDetailModal } from "../components/NoteDetailModal";
import { useKeyboardOverlap } from "../hooks/useKeyboardOverlap";

jest.setTimeout(30_000);

// Captures the keyboard listeners so tests can raise/lower the keyboard.
const keyboardHandlers = new Map<string, (e?: unknown) => void>();
beforeEach(() => {
  keyboardHandlers.clear();
  jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, handler: (e?: unknown) => void) => {
    keyboardHandlers.set(event, handler);
    return { remove: () => keyboardHandlers.delete(event) };
  }) as never);
  mockGetNoteById.mockResolvedValue(NOTE);
});
afterEach(() => jest.restoreAllMocks());

function showKeyboard(height: number, screenY: number) {
  const handler = keyboardHandlers.get("keyboardDidShow") ?? keyboardHandlers.get("keyboardWillShow");
  act(() => handler?.({ endCoordinates: { height, screenY, screenX: 0, width: 400 } }));
}
function hideKeyboard() {
  const handler = keyboardHandlers.get("keyboardDidHide") ?? keyboardHandlers.get("keyboardWillHide");
  act(() => handler?.());
}

const NOTE = {
  id: "note-1",
  content: "Theo came by to pick the vaccum.",
  transcript: null,
  audioUri: null,
  status: "embedded",
  transcriptionModel: null,
  createdAt: Math.floor(new Date(2026, 9, 7, 21, 32).getTime() / 1000),
};

async function renderModal(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<NoteDetailModal noteId="note-1" visible onClose={jest.fn()} />);
  });
  return tree;
}

/**
 * React Native's Jest mock gives views a `measureInWindow` that never calls
 * back (on a device it always does), so tests stand in the device's answer:
 * every mounted view reports `frame` in window coordinates.
 */
function stubWindowFrame(tree: ReactTestRenderer, frame: { y: number; height: number }) {
  for (const node of tree.root.findAll(() => true)) {
    const instance = node.instance as { measureInWindow?: unknown } | null;
    if (instance && typeof instance.measureInWindow === "function") {
      instance.measureInWindow = (cb: (x: number, y: number, w: number, h: number) => void) =>
        cb(0, frame.y, 400, frame.height);
    }
  }
}

const backdropPadding = (tree: ReactTestRenderer) =>
  StyleSheet.flatten(tree.root.findByProps({ testID: "note-detail-backdrop" }).props.style).paddingBottom;

describe("NoteDetailModal — editing with the keyboard open", () => {
  it("lifts the sheet above the keyboard in edit mode, keeping the input and Save/Cancel", async () => {
    const tree = await renderModal();
    await act(async () => tree.root.findByProps({ testID: "note-edit-button" }).props.onPress());
    expect(tree.root.findByType(TextInput).props.autoFocus).toBe(true);

    stubWindowFrame(tree, { y: 0, height: 800 }); // full-screen modal, not resized
    showKeyboard(300, 500);
    expect(backdropPadding(tree)).toBe(300);
    expect(tree.root.findByProps({ testID: "note-edit-input" })).toBeTruthy();
    expect(tree.root.findByProps({ testID: "note-edit-save" })).toBeTruthy();
    expect(tree.root.findByProps({ testID: "note-edit-cancel" })).toBeTruthy();

    hideKeyboard();
    expect(backdropPadding(tree)).toBe(0);
  });

  it("still saves the edit while the keyboard is up", async () => {
    const tree = await renderModal();
    await act(async () => tree.root.findByProps({ testID: "note-edit-button" }).props.onPress());
    showKeyboard(300, 500);
    await act(async () => tree.root.findByType(TextInput).props.onChangeText("Theo came by to pick the vacuum."));
    await act(async () => tree.root.findByProps({ testID: "note-edit-save" }).props.onPress());
    expect(mockUpdateNoteText).toHaveBeenCalledWith("note-1", "Theo came by to pick the vacuum.");
  });

  it("Cancel returns to the normal view with the keyboard up, and the layout settles when it closes", async () => {
    const tree = await renderModal();
    await act(async () => tree.root.findByProps({ testID: "note-edit-button" }).props.onPress());
    showKeyboard(300, 500);
    await act(async () => tree.root.findByProps({ testID: "note-edit-cancel" }).props.onPress());
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    expect(tree.root.findByProps({ testID: "note-edit-button" })).toBeTruthy();
    hideKeyboard();
    expect(backdropPadding(tree)).toBe(0);
  });

  it("leaves the normal note view as it was", async () => {
    const tree = await renderModal();
    expect(backdropPadding(tree)).toBe(0);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    expect(tree.root.findByProps({ testID: "note-edit-button" })).toBeTruthy();
  });

  it("stops listening when closed", async () => {
    const tree = await renderModal();
    expect(keyboardHandlers.size).toBe(2);
    act(() => tree.unmount());
    expect(keyboardHandlers.size).toBe(0);
  });
});

describe("useKeyboardOverlap — measured, so it never double-compensates", () => {
  function Probe({ onOverlap }: { onOverlap: (n: number) => void }) {
    const ref = useRef<View>(null);
    onOverlap(useKeyboardOverlap(ref));
    return <View ref={ref} />;
  }

  async function measureWith(frame: { y: number; height: number }) {
    let overlap = -1;
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe onOverlap={(n) => (overlap = n)} />);
    });
    stubWindowFrame(tree, frame);
    return () => overlap;
  }

  it("covers the keyboard when the window is not resized (edge-to-edge modal)", async () => {
    const overlap = await measureWith({ y: 0, height: 800 });
    showKeyboard(300, 500);
    expect(overlap()).toBe(300);
  });

  it("adds nothing when the OS already resized the window above the keyboard", async () => {
    const overlap = await measureWith({ y: 0, height: 500 });
    showKeyboard(300, 500);
    expect(overlap()).toBe(0);
  });
});
