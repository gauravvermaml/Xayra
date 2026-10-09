import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Text, TextInput } from "react-native";

const mockGetNoteById = jest.fn();
const mockUpdateNoteText = jest.fn((_id: string, _text: string) => Promise.resolve());
jest.mock("../services/notes/noteManager", () => ({
  getNoteById: (id: string) => mockGetNoteById(id),
  updateNoteText: (id: string, text: string) => mockUpdateNoteText(id, text),
  deleteNote: jest.fn(() => Promise.resolve()),
}));
jest.mock("../services/audio/player", () => ({ useAudioPlayerControls: () => ({ pause: jest.fn() }) }));
jest.mock("../components/AudioPlayerControls", () => ({ AudioPlayerControls: () => null }));
jest.mock("../utils/clipboard", () => ({ copyTextWithFeedback: jest.fn() }));

import { NoteCard } from "../components/NoteCard";
import { NoteDetailModal } from "../components/NoteDetailModal";

// Rendering the modal pulls in the icon font and the full component tree;
// on a cold transform cache the first render alone can exceed Jest's 5 s default.
jest.setTimeout(30_000);

const texts = (tree: ReactTestRenderer) => tree.root.findAllByType(Text).map((t) => [t.props.children].flat().join(""));
const RECORDED = Math.floor(new Date(2026, 9, 7, 21, 32).getTime() / 1000);

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(element);
  });
  return tree;
}

describe("NoteCard", () => {
  it.each([
    ["a typed note", null],
    ["a legacy note with audio", "file:///old.wav"],
  ])("shows no input-method tag for %s, but keeps the date and the delete control", async (_label, audioUri) => {
    const onDelete = jest.fn();
    const tree = await render(<NoteCard content="Theo came by." audioUri={audioUri} createdAt={RECORDED} onDelete={onDelete} />);
    const all = texts(tree).join(" ");
    expect(all).not.toMatch(/#Text|#Voice/);
    expect(tree.root.findByProps({ testID: "note-card-date" })).toBeTruthy();
    expect(all).toContain("Theo came by.");
    expect(all).toContain("🗑");
  });
});

describe("NoteDetailModal — editing a journal note", () => {
  const NOTE = {
    id: "note-1",
    content: "Theo came by to pick the vaccum.",
    transcript: null,
    audioUri: null,
    status: "embedded",
    transcriptionModel: null,
    createdAt: RECORDED,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetNoteById.mockResolvedValue(NOTE);
  });

  it("pencil → edit state → Save corrects the same note and reports it", async () => {
    const onUpdated = jest.fn();
    const tree = await render(<NoteDetailModal noteId="note-1" visible onClose={jest.fn()} onUpdated={onUpdated} />);

    await act(async () => tree.root.findByProps({ testID: "note-edit-button" }).props.onPress());
    const input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe(NOTE.content);
    expect(texts(tree)).toContain("Edit note");

    mockGetNoteById.mockResolvedValue({ ...NOTE, content: "Theo came by to pick the vacuum." });
    await act(async () => input.props.onChangeText("Theo came by to pick the vacuum."));
    await act(async () => tree.root.findByProps({ testID: "note-edit-save" }).props.onPress());

    expect(mockUpdateNoteText).toHaveBeenCalledWith("note-1", "Theo came by to pick the vacuum.");
    expect(onUpdated).toHaveBeenCalledWith("note-1");
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    expect(texts(tree)).toContain("Theo came by to pick the vacuum.");
  });

  it("Cancel leaves the note untouched", async () => {
    const tree = await render(<NoteDetailModal noteId="note-1" visible onClose={jest.fn()} />);
    await act(async () => tree.root.findByProps({ testID: "note-edit-button" }).props.onPress());
    await act(async () => tree.root.findByType(TextInput).props.onChangeText("something else"));
    await act(async () => tree.root.findByProps({ testID: "note-edit-cancel" }).props.onPress());

    expect(mockUpdateNoteText).not.toHaveBeenCalled();
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    expect(texts(tree)).toContain(NOTE.content);
  });

  it("the recorded date shown is unchanged by an edit", async () => {
    const tree = await render(<NoteDetailModal noteId="note-1" visible onClose={jest.fn()} />);
    const recordedText = new Date(RECORDED * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    expect(texts(tree)).toContain(recordedText);
    await act(async () => tree.root.findByProps({ testID: "note-edit-button" }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: "note-edit-save" }).props.onPress());
    expect(texts(tree)).toContain(recordedText);
  });
});
