/**
 * Gate 3A (release blocker 2, consecutive typed notes): a quick double tap on
 * Send saves the note once and keeps the tap on Send. The second tap used to
 * land on a `disabled` Send button, which doesn't claim the touch, so it fell
 * through to the home canvas's tap-to-dismiss and closed the keyboard mid
 * entry. Send now always claims the touch; handleSubmit ignores empty and
 * pending submits; TalkBack still hears it as disabled when empty.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Keyboard } from "react-native";

jest.mock("@gorhom/bottom-sheet", () => {
  const { TextInput: RNTextInput } = jest.requireActual("react-native");
  return { BottomSheetTextInput: RNTextInput };
});

import { ComposeBar } from "../components/ComposeBar";

const submitButton = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => n.props.testID === "compose-submit" && typeof n.props.onPress === "function")[0];

async function render(inputText: string, onSubmit = jest.fn(), mode: "record" | "ask" = "record") {
  let tree!: ReactTestRenderer;
  const el = (text: string) => (
    <ComposeBar
      inputText={text}
      onInputChange={() => {}}
      onInputFocus={() => {}}
      onInputBlur={() => {}}
      onSubmit={onSubmit}
      placeholder="Type your thoughts..."
      mode={mode}
    />
  );
  await act(async () => {
    tree = create(el(inputText));
  });
  return { tree, onSubmit, rerender: async (text: string) => act(async () => tree.update(el(text))) };
}

describe("Send under a quick double tap", () => {
  it("is never a disabled (touch-transparent) Pressable, even when the field is empty", async () => {
    const { tree } = await render("");
    expect(submitButton(tree).props.disabled).toBeFalsy();
    expect(submitButton(tree).props.accessibilityState).toEqual({ disabled: true });
  });

  it("saves the note exactly once when tapped twice before the field clears", async () => {
    const { tree, onSubmit } = await render("G3 synthetic note");
    await act(async () => {
      submitButton(tree).props.onPress();
      submitButton(tree).props.onPress();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("G3 synthetic note");
  });

  it("a tap on the emptied Send does nothing — no submit, no keyboard dismissal", async () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    const { tree, onSubmit, rerender } = await render("first");
    await act(async () => submitButton(tree).props.onPress());
    await rerender(""); // the parent clears the field after a submit
    await act(async () => submitButton(tree).props.onPress());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled(); // Record mode keeps the keyboard for the next note
    dismiss.mockRestore();
  });

  it("the next note after a cleared field submits normally", async () => {
    const { tree, onSubmit, rerender } = await render("first");
    await act(async () => submitButton(tree).props.onPress());
    await rerender("");
    await rerender("second");
    await act(async () => submitButton(tree).props.onPress());
    expect(onSubmit.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
  });
});
