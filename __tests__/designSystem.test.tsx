/**
 * Xayra 2.0 design foundations (Stage 1): palette contrast, the type scale,
 * and the accessibility contract of the presentation components.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Text } from "react-native";

import {
  BRAND_MAX_FONT_SCALE,
  MIN_TOUCH_TARGET,
  xayraColors as c,
  xayraType,
} from "../constants/xayraTheme";
import { contrastRatio, flatten } from "../utils/contrast";
import { XText } from "../components/ui/XText";
import { Chip } from "../components/ui/Chip";
import { IconButton } from "../components/ui/IconButton";
import { Pill } from "../components/ui/Pill";
import { SegmentedControl } from "../components/ui/SegmentedControl";

const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

describe("palette contrast (WCAG, against the surfaces each token is drawn on)", () => {
  const textPairs: [string, string, string][] = [
    ["text on black", c.text, c.background],
    ["guidance / cue on black", c.textMuted, c.background],
    ["answer on tray", c.text, c.surface],
    ["question on tray", c.textSoft, c.surface],
    ["role label on tray", c.textFaint, c.surface],
    ["Xayra label on tray", c.lilac, c.surface],
    ["placeholder on field", c.textFaint, c.field],
    ["inactive segment on track", c.textMuted, c.field],
    ["selected segment", c.text, c.raised],
    ["dock label on dock", c.dockText, c.dock],
    ["note link on its chip", c.lilacText, flatten(c.lilacSoft, c.surface)],
    ["send arrow on its circle", c.teal, flatten(c.tealSoft, c.field)],
    ["Handsfree active label", c.teal, flatten(c.tealSoft, c.dock)],
    ["To-Dos badge", c.badgeText, flatten(c.badge, c.dock)],
  ];
  it.each(textPairs)("%s ≥ 4.5:1", (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it("drag handle on the tray ≥ 3:1", () => {
    expect(contrastRatio(c.handle, c.surface)).toBeGreaterThanOrEqual(NON_TEXT_MIN);
  });

  it("selected-segment ring against the track ≥ 3:1", () => {
    expect(contrastRatio(flatten(c.lilacRing, c.raised), c.field)).toBeGreaterThanOrEqual(NON_TEXT_MIN);
  });

  it("hairlines stay decorative (< 3:1) — controls must not rely on them alone", () => {
    // Documented, not a failure: the field and dock outlines are identified by
    // their icons and labels. If a hairline ever has to carry meaning, this
    // test is the reminder that it can't.
    expect(contrastRatio(c.line, c.surface)).toBeLessThan(NON_TEXT_MIN);
    expect(contrastRatio(c.lineStrong, c.surface)).toBeLessThan(NON_TEXT_MIN);
  });

  it("main background is genuine black", () => {
    expect(c.background).toBe("#000000");
  });
});

describe("type scale", () => {
  const sizes = Object.values(xayraType);
  it("never goes below 12.5dp or weight 400", () => {
    for (const token of sizes) {
      expect(token.fontSize).toBeGreaterThanOrEqual(12.5);
      expect(Number(token.fontWeight)).toBeGreaterThanOrEqual(400);
    }
  });
  it("uses the approved reading sizes", () => {
    expect(xayraType.guidance).toMatchObject({ fontSize: 15, lineHeight: 22 });
    expect(xayraType.answer).toMatchObject({ fontSize: 17, lineHeight: 26, fontFamily: "DMSans" });
    expect(xayraType.wordmark).toMatchObject({ fontFamily: "PlusJakartaSans", fontWeight: "700" });
  });
  it("only the wordmark has letter spacing, and it tightens", () => {
    for (const [name, token] of Object.entries(xayraType)) {
      const spacing = (token as { letterSpacing?: number }).letterSpacing;
      if (name === "wordmark") expect(spacing).toBeLessThan(0);
      else expect(spacing).toBeUndefined();
    }
  });
});

/** Topmost elements with this accessibility role and a press handler. */
function byRole(tree: ReactTestRenderer, role: string) {
  return tree.root.findAll((n) => n.props.accessibilityRole === role && typeof n.props.onPress === "function", {
    deep: false,
  });
}

function render(element: React.ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree!;
}

describe("XText", () => {
  it("follows system font scaling for functional text", () => {
    const tree = render(<XText variant="answer">Hello</XText>);
    const text = tree.root.findByType(Text);
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.maxFontSizeMultiplier).toBeUndefined();
  });
  it("lets only the wordmark stop growing at the brand limit", () => {
    const tree = render(<XText variant="wordmark">Xayra</XText>);
    expect(tree.root.findByType(Text).props.maxFontSizeMultiplier).toBe(BRAND_MAX_FONT_SCALE);
  });
  it("applies the token's family, size and default colour", () => {
    const tree = render(<XText variant="roleLabel">You</XText>);
    const style = Object.assign({}, ...[tree.root.findByType(Text).props.style].flat(2));
    expect(style).toMatchObject({ fontFamily: "DMSans", fontSize: 13, fontWeight: "600", color: c.textFaint });
  });
});

describe("controls", () => {
  it("SegmentedControl announces the selected segment and blocks changes when locked", () => {
    const onChange = jest.fn();
    const segments = [
      { key: "record", label: "Record" },
      { key: "ask", label: "Ask" },
    ] as const;
    const tree = render(
      <SegmentedControl segments={segments} value="record" onChange={onChange} accessibilityLabel="Mode" />
    );
    const radios = byRole(tree, "radio");
    expect(radios.map((r) => r.props.accessibilityState.selected)).toEqual([true, false]);
    act(() => radios[1].props.onPress());
    expect(onChange).toHaveBeenCalledWith("ask");

    const locked = render(
      <SegmentedControl segments={segments} value="record" onChange={onChange} disabled accessibilityLabel="Mode" />
    );
    const lockedRadios = locked.root.findAll((n) => n.props.accessibilityRole === "radio", { deep: false });
    expect(lockedRadios.every((r) => r.props.disabled === true && r.props.accessibilityState.disabled)).toBe(true);
  });

  it("IconButton reaches a 48dp target and requires a label", () => {
    const tree = render(<IconButton accessibilityLabel="Collapse" icon={null} size={40} onPress={() => {}} />);
    const [button] = byRole(tree, "button");
    expect(button.props.accessibilityLabel).toBe("Collapse");
    expect(40 + 2 * button.props.hitSlop).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  it("Chip and Pill expose their label and a 48dp target", () => {
    const [chip] = byRole(render(<Chip label="[Note 1]" onPress={() => {}} />), "button");
    expect(chip.props.accessibilityLabel).toBe("[Note 1]");
    expect(40 + 2 * chip.props.hitSlop).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    const [pill] = byRole(render(<Pill label="Listen" onPress={() => {}} />), "button");
    expect(pill.props.accessibilityRole).toBe("button");
    expect(40 + 2 * pill.props.hitSlop).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });
});
