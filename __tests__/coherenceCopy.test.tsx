/**
 * 1.0.40 copy/presentation coherence: wording that follows the selected
 * Record/Ask mode, and no copy that over-promises.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Text, TextInput } from "react-native";

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
jest.mock("../utils/clipboard", () => ({ copyTextWithFeedback: jest.fn() }));
jest.mock("../services/audio/player", () => ({ useAudioPlayerControls: () => ({ pause: jest.fn() }) }));
jest.mock("../components/AudioPlayerControls", () => ({ AudioPlayerControls: () => null }));

import {
  ARCHIVE_EMPTY_SUBTEXT,
  ASK_STARTER_PROMPTS,
  HOME_SUBTITLE,
  IDLE_TAP_CUE,
  RECORD_EMPTY_SUBTEXT,
} from "../constants/copy";
import { ChatSheetContent } from "../components/ChatSheetContent";
import { ComposeBar } from "../components/ComposeBar";
import { NotesSheetContent } from "../components/NotesSheetContent";
import { idleTapCue } from "../services/audio/manualUtterance";

jest.setTimeout(30_000);

const texts = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat().join(""))
    .join(" | ");

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(element);
  });
  return tree;
}

describe("home subtitle follows Record vs Ask", () => {
  it("Record explains journaling and to-dos", () => {
    expect(HOME_SUBTITLE.record).toBe("Speak or type a thought. Say “remind me…” to create a to-do.");
  });
  it("Ask describes asking, with no to-do/journal instructions", () => {
    expect(HOME_SUBTITLE.ask).toBe("Ask Xayra about anything you’ve recorded.");
    expect(HOME_SUBTITLE.ask).not.toMatch(/remind|to-do|journal/i);
  });
});

describe("idle tap cue", () => {
  const idle = { canvasState: "idle" as const, manualPhase: "idle" as const, isHandsfreeActive: false };

  it("says what a tap will do in each mode", () => {
    expect(idleTapCue({ ...idle, mode: "record" })).toBe("Tap to record");
    expect(idleTapCue({ ...idle, mode: "ask" })).toBe("Tap to ask");
    expect(IDLE_TAP_CUE).toEqual({ record: "Tap to record", ask: "Tap to ask" });
  });

  it.each([
    ["recording", { canvasState: "recording" as const }],
    ["processing", { canvasState: "transcribing" as const }],
    ["Handsfree listening", { canvasState: "listening" as const, isHandsfreeActive: true }],
    ["Handsfree engaged but between utterances", { isHandsfreeActive: true }],
    ["a recording starting", { manualPhase: "starting" as const }],
    ["a manual utterance finishing", { manualPhase: "processing" as const }],
  ])("is hidden while %s", (_label, override) => {
    for (const mode of ["record", "ask"] as const) {
      expect(idleTapCue({ ...idle, ...override, mode })).toBeNull();
    }
  });
});

describe("compose bar icon follows the mode", () => {
  const props = {
    inputText: "",
    onInputChange: jest.fn(),
    onInputFocus: jest.fn(),
    onInputBlur: jest.fn(),
    onSubmit: jest.fn(),
  };

  it("Record shows a pencil, Ask a search icon", async () => {
    const record = await render(<ComposeBar {...props} placeholder="Type your thoughts..." mode="record" />);
    expect(record.root.findByProps({ testID: "compose-mode-icon" }).props.name).toBe("edit-3");
    const ask = await render(<ComposeBar {...props} placeholder="Search your thoughts..." mode="ask" />);
    expect(ask.root.findByProps({ testID: "compose-mode-icon" }).props.name).toBe("search");
  });

  it("leaves the input itself unchanged (multiline, no submit-on-enter)", async () => {
    const tree = await render(<ComposeBar {...props} placeholder="Type your thoughts..." mode="record" />);
    const input = tree.root.findByType(TextInput);
    expect(input.props.multiline).toBe(true);
    expect(input.props.blurOnSubmit).toBe(false);
    expect(input.props.returnKeyType).toBeUndefined();
  });
});

describe("Ask starter prompts", () => {
  it("only promise what Ask answers from — recorded notes", () => {
    expect(ASK_STARTER_PROMPTS).toEqual([
      "Summarize my latest notes",
      "What did I record about work?",
      "What reminders have I recorded recently?",
    ]);
    expect(ASK_STARTER_PROMPTS.join(" ")).not.toMatch(/list my recent tasks/i);
  });
});

describe("empty states", () => {
  const chatProps = {
    notes: [],
    onDeleteNote: jest.fn(),
    isRestoring: false,
    onRestoreFromDrive: jest.fn(),
    messages: [],
    isSending: false,
    speakingMessageId: null,
    modelDownload: { phase: "ready" } as never,
    isModelReady: true,
    onSubmitStarterPrompt: jest.fn(),
    onToggleSpeech: jest.fn(),
    onShowCitation: jest.fn(),
    bottomInset: 0,
    usePlainList: true,
  };

  it("home Record tray invites speaking or typing, and keeps Drive restore", async () => {
    const tree = await render(<ChatSheetContent {...chatProps} mode="record" />);
    const all = texts(tree);
    expect(all).toContain(RECORD_EMPTY_SUBTEXT);
    expect(RECORD_EMPTY_SUBTEXT).toBe("Tap Xayra to speak, or type your first thought below.");
    expect(all).not.toContain("first voice note");
    expect(all).toContain("Restore vault from Google Drive");
  });

  it("home Ask tray shows the truthful starter prompts", async () => {
    const tree = await render(<ChatSheetContent {...chatProps} mode="ask" />);
    const all = texts(tree);
    for (const prompt of ASK_STARTER_PROMPTS) expect(all).toContain(prompt);
    expect(all).not.toContain("List my recent tasks");
  });

  it("starter prompts sit at the top of the Ask tray, in its empty state, and submit when tapped", async () => {
    const onSubmitStarterPrompt = jest.fn();
    const tree = await render(<ChatSheetContent {...chatProps} mode="ask" onSubmitStarterPrompt={onSubmitStarterPrompt} />);
    const row = tree.root.findByProps({ testID: "ask-starter-prompts" });
    // Rendered by the list's empty state (top of the tray), not after the list.
    const { FlatList } = jest.requireActual("react-native");
    const list = tree.root.findByType(FlatList);
    expect(list.findByProps({ testID: "ask-starter-prompts" })).toBe(row);
    const chips = row.findAll((node) => typeof node.props.onPress === "function" && node.props.disabled === false);
    expect(chips).toHaveLength(3);
    await act(async () => chips[2].props.onPress());
    expect(onSubmitStarterPrompt).toHaveBeenCalledWith("What reminders have I recorded recently?");
  });

  it("starter prompts wait for the model, and go away once something has been asked", async () => {
    const notReady = await render(<ChatSheetContent {...chatProps} mode="ask" isModelReady={false} />);
    expect(notReady.root.findAllByProps({ testID: "ask-starter-prompts" })).toHaveLength(0);
    const asked = await render(
      <ChatSheetContent
        {...chatProps}
        mode="ask"
        messages={[{ id: "u1", role: "user", text: "What did I record about work?" } as never]}
      />
    );
    expect(asked.root.findAllByProps({ testID: "ask-starter-prompts" })).toHaveLength(0);
  });

  it("Archive says the same thing, pointing to where you can speak or type", async () => {
    const tree = await render(
      <NotesSheetContent
        notes={[]}
        isSearchActive={false}
        onSelectNote={jest.fn()}
        onDeleteNote={jest.fn()}
        isRestoring={false}
        onRestoreFromDrive={jest.fn()}
        bottomInset={0}
        usePlainList
      />
    );
    const all = texts(tree);
    expect(all).toContain(ARCHIVE_EMPTY_SUBTEXT);
    expect(all).not.toContain("first voice note");
    expect(all).toContain("Restore vault from Google Drive");
  });
});

describe("idle cue spacing", () => {
  it("starts below the button's shadow, with breathing room", () => {
    jest.doMock("react-native-worklets", () => require("react-native-worklets/src/mock"));
    jest.doMock("react-native-reanimated", () => require("react-native-reanimated/mock"));
    let constants!: { BUTTON_SHADOW_EXTENT_PX: number; IDLE_TEXT_CLEARANCE_PX: number };
    jest.isolateModules(() => {
      constants = require("../components/CentralRecorderCanvas");
    });
    const { BUTTON_SHADOW_EXTENT_PX, IDLE_TEXT_CLEARANCE_PX } = constants;
    expect(BUTTON_SHADOW_EXTENT_PX).toBe(28);
    expect(IDLE_TEXT_CLEARANCE_PX).toBeGreaterThanOrEqual(BUTTON_SHADOW_EXTENT_PX + 8);
  });
});

describe("onboarding claims", () => {
  it("no longer promises '100% offline privacy'", () => {
    // Imported lazily: the screen pulls in the download/calibration services.
    jest.isolateModules(() => {
      jest.doMock("../services/ai/memoryGuard", () => ({}));
      jest.doMock("../services/ai/modelDownloadManager", () => ({}));
      jest.doMock("../services/settings/appSettings", () => ({}));
      jest.doMock("../services/notifications/setupCompleteNotification", () => ({}));
      jest.doMock("../services/settings/preferences", () => ({}));
      const { COSMETIC_STEPS } = require("../components/OnboardingSetupScreen");
      const labels = COSMETIC_STEPS.map((s: { label: string }) => s.label).join(" ");
      expect(labels).not.toMatch(/100%|offline privacy/i);
      expect(labels).toContain("Keeping your AI processing on-device");
    });
  });
});
