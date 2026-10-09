import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Text } from "react-native";

import { RelatedNotesSection } from "../components/RelatedNotesSection";
import type { RagCitation } from "../services/ai/rag";

// Up to three notes can qualify (rag.ts's CONTEXT_NOTE_LIMIT is 3): they
// must render as ONE section with one tappable row each, each showing its own
// recorded date and excerpt.
const at = (y: number, m: number, d: number, h: number, mi: number) => Math.floor(new Date(y, m - 1, d, h, mi).getTime() / 1000);
const NOTES: RagCitation[] = [
  { index: 1, noteId: "marco", content: "Marco was away for 3 weeks while he moved house.", createdAt: at(2026, 10, 6, 13, 8) },
  { index: 2, noteId: "theo", content: "Theo just came by to pick the vacuum.", createdAt: at(2026, 10, 7, 21, 32) },
  { index: 3, noteId: "priya", content: "Remind me of Priya's meeting coming Friday in the morning.", createdAt: at(2026, 10, 9, 17, 16) },
];
const recorded = (createdAt: number) => new Date(createdAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function render(notes: RagCitation[], onOpen: (id: string) => void = () => {}): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<RelatedNotesSection notes={notes} onOpen={onOpen} />);
  });
  return tree;
}

const texts = (tree: ReactTestRenderer) => tree.root.findAllByType(Text).map((t) => [t.props.children].flat().join(""));

describe("RelatedNotesSection", () => {
  it("renders three notes as one section with three stacked rows, each with its own date and excerpt", () => {
    const tree = render(NOTES);
    const all = texts(tree);
    expect(all.filter((t) => t === "Related notes")).toHaveLength(1);
    const rows = tree.root.findAll((n) => typeof n.props.testID === "string" && n.props.testID.startsWith("related-note-"), { deep: false });
    expect(rows.map((r) => r.props.testID)).toEqual(["related-note-marco", "related-note-theo", "related-note-priya"]);
    for (const note of NOTES) {
      expect(all).toContain(recorded(note.createdAt));
      expect(all).toContain(note.content);
    }
  });

  it("tapping a row opens that note", () => {
    const opened: string[] = [];
    const tree = render(NOTES, (id) => opened.push(id));
    act(() => {
      tree.root.findByProps({ testID: "related-note-theo" }).props.onPress();
    });
    expect(opened).toEqual(["theo"]);
  });

  it("renders nothing when no notes qualify", () => {
    expect(render([]).toJSON()).toBeNull();
  });

  it("never uses source/citation wording", () => {
    const all = texts(render(NOTES)).join(" ");
    expect(all).not.toMatch(/\[Note \d\]|source|proof|verified/i);
  });
});
