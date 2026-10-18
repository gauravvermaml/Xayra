/**
 * Xayra 2.0 Stage 3: the home tray's restyled answers and note cards keep
 * every behaviour they had — Listen/Stop, citation links, related notes,
 * open/delete/copy — while presenting borderless answers with sentence-case
 * You / Xayra labels.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { StyleSheet, Text } from "react-native";

jest.mock("@gorhom/bottom-sheet", () => {
  const { FlatList, TextInput: RNTextInput } = jest.requireActual("react-native");
  return { BottomSheetTextInput: RNTextInput, BottomSheetFlatList: FlatList };
});
jest.mock("../services/ai/localWhisper", () => ({ cancelActiveTranscription: jest.fn() }));
jest.mock("../services/ai/localLlama", () => ({ cancelActiveLlamaCompletion: jest.fn() }));
jest.mock("../services/ai/modelDownloadManager", () => ({
  allowCellularDownloadAndResume: jest.fn(),
  resumeDownloads: jest.fn(),
}));
const mockCopy = jest.fn();
jest.mock("../utils/clipboard", () => ({ copyTextWithFeedback: (text: string) => mockCopy(text) }));
jest.mock("../services/audio/player", () => ({ useAudioPlayerControls: () => ({ pause: jest.fn() }) }));
jest.mock("../components/AudioPlayerControls", () => ({ AudioPlayerControls: () => null }));

import { ChatSheetContent } from "../components/ChatSheetContent";
import { NoteCard } from "../components/NoteCard";
import type { ChatMessage } from "../services/ai/useChatSession";

jest.setTimeout(30_000);

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((t) => [t.props.children].flat().join(""));

// Unmounted after each test: the streaming label runs an endless animation
// loop that would otherwise keep Jest alive after the suite finishes.
const mounted: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => mounted.splice(0).forEach((tree) => tree.unmount()));
});

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(element);
  });
  mounted.push(tree);
  return tree;
}

const pressByLabel = (tree: ReactTestRenderer, label: string) =>
  tree.root
    .findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === "function")[0]
    .props.onPress();

const baseProps = {
  notes: [],
  onDeleteNote: jest.fn(),
  isRestoring: false,
  onRestoreFromDrive: jest.fn(),
  isSending: false,
  modelDownload: { status: "ready" } as never,
  isModelReady: true,
  onSubmitStarterPrompt: jest.fn(),
  listBottomPadding: 0,
  usePlainList: true,
};

const exchange: ChatMessage[] = [
  { id: "u1", role: "user", text: "When is the check-up?" },
  {
    id: "a1",
    role: "assistant",
    text: "The check-up moved to Thursday.\n\nBring the insurance letter.",
    citations: [
      { noteId: "n1", index: 1, createdAt: 1_760_000_000, content: "Synthetic: check-up Thursday" },
      { noteId: "n2", index: 2, createdAt: 1_760_000_100, content: "Synthetic: insurance letter" },
    ] as never,
  },
];

describe("borderless Ask answers", () => {
  it("labels turns in sentence case and keeps the answer's paragraphs at 17/26", async () => {
    const tree = await render(
      <ChatSheetContent {...baseProps} mode="ask" messages={exchange} speakingMessageId={null} onToggleSpeech={jest.fn()} onShowCitation={jest.fn()} />
    );
    const all = texts(tree);
    expect(all).toContain("You");
    expect(all).toContain("Xayra");
    expect(all.join(" ")).not.toMatch(/\bYOU\b|\bXAYRA\b/);
    const paragraphs = tree.root
      .findAllByType(Text)
      .filter((t) => {
        const s = StyleSheet.flatten(t.props.style);
        return s?.fontSize === 17 && s?.lineHeight === 26;
      })
      .map((t) => [t.props.children].flat().map((c) => (typeof c === "string" ? c : "")).join(""));
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
  });

  it("no bubble: the answer turn has no background fill or border", async () => {
    const tree = await render(
      <ChatSheetContent {...baseProps} mode="ask" messages={exchange} speakingMessageId={null} onToggleSpeech={jest.fn()} onShowCitation={jest.fn()} />
    );
    const turns = tree.root.findAll(
      (n) => typeof n.props.onLongPress === "function" && n.props.style !== undefined && typeof n.type !== "string",
      { deep: false }
    );
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) {
      const s = StyleSheet.flatten(turn.props.style) ?? {};
      expect(s.backgroundColor).toBeUndefined();
      expect(s.borderWidth).toBeUndefined();
    }
  });

  it("Listen toggles speech; source notes open the cited note", async () => {
    const onToggleSpeech = jest.fn();
    const onShowCitation = jest.fn();
    const tree = await render(
      <ChatSheetContent {...baseProps} mode="ask" messages={exchange} speakingMessageId={null} onToggleSpeech={onToggleSpeech} onShowCitation={onShowCitation} />
    );
    expect(texts(tree)).toEqual(expect.arrayContaining(["Listen", "[Note 1]", "[Note 2]"]));
    await act(async () => pressByLabel(tree, "Listen to this answer"));
    expect(onToggleSpeech).toHaveBeenCalledWith(exchange[1]);
    await act(async () => pressByLabel(tree, "Open source note 2"));
    expect(onShowCitation).toHaveBeenCalledWith("n2");
  });

  it("shows Stop while that answer is being spoken", async () => {
    const tree = await render(
      <ChatSheetContent {...baseProps} mode="ask" messages={exchange} speakingMessageId="a1" onToggleSpeech={jest.fn()} onShowCitation={jest.fn()} />
    );
    expect(texts(tree)).toContain("Stop");
    expect(texts(tree)).not.toContain("Listen");
  });

  it("long-press on an answer still copies it", async () => {
    mockCopy.mockClear();
    const tree = await render(
      <ChatSheetContent {...baseProps} mode="ask" messages={exchange} speakingMessageId={null} onToggleSpeech={jest.fn()} onShowCitation={jest.fn()} />
    );
    const answerTurn = tree.root.findAll(
      (n) => typeof n.props.onLongPress === "function" && n.props.disabled === false,
      { deep: false }
    )[1];
    await act(async () => answerTurn.props.onLongPress());
    expect(mockCopy).toHaveBeenCalledWith(exchange[1].text);
  });

  it("no Listen or source links while the answer is still streaming", async () => {
    const streaming: ChatMessage[] = [exchange[0], { id: "a1", role: "assistant", text: "", isStreaming: true }];
    const tree = await render(
      <ChatSheetContent {...baseProps} mode="ask" messages={streaming} speakingMessageId={null} onToggleSpeech={jest.fn()} onShowCitation={jest.fn()} />
    );
    expect(texts(tree)).not.toContain("Listen");
    expect(texts(tree).some((t) => /\[Note/.test(t))).toBe(false);
  });
});

describe("home note card (xayra appearance)", () => {
  it("keeps the date, open, copy and an accessible delete", async () => {
    const onPress = jest.fn();
    const onDelete = jest.fn();
    mockCopy.mockClear();
    const tree = await render(
      <NoteCard appearance="xayra" content="Synthetic note" createdAt={1_760_000_000} onPress={onPress} onDelete={onDelete} />
    );
    expect(tree.root.findByProps({ testID: "note-card-date" })).toBeTruthy();
    await act(async () => pressByLabel(tree, "Delete note"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    const card = tree.root.findAll((n) => typeof n.props.onLongPress === "function", { deep: false })[0];
    await act(async () => card.props.onPress());
    await act(async () => card.props.onLongPress());
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(mockCopy).toHaveBeenCalledWith("Synthetic note");
  });

  it("Archive's classic card is unchanged (default appearance)", async () => {
    const tree = await render(<NoteCard content="Synthetic note" onDelete={jest.fn()} />);
    expect(texts(tree)).toContain("🗑");
  });
});
