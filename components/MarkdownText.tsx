import { Fragment } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing, typography } from "../constants/theme";

export type MarkdownTextProps = {
  text: string;
  /** Base text color — bubble background differs between user/assistant, so
   * the caller decides the readable foreground rather than this component
   * guessing. */
  color?: string;
  /** Enables native text selection/highlighting (long-press to select,
   * system copy handles) on every rendered Text node. Defaults to true —
   * chat answers are exactly the kind of content users want to select and
   * copy, so opting in per call site would just mean every real call site
   * remembering to pass it. */
  selectable?: boolean;
};

/**
 * Minimal, dependency-free Markdown rendering for Llama's chat output:
 * headings, bullet lists, fenced code blocks, and bold/italic emphasis.
 * Not a general Markdown parser — just enough of the subset a local LLM
 * actually produces to read noticeably better than a raw text dump, without
 * pulling in a Markdown rendering library.
 */
function renderInline(line: string, keyPrefix: string, color: string, selectable: boolean) {
  // Splits on **bold** and *italic* without consuming the other pattern —
  // simple alternation, good enough for single-level emphasis.
  const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <Text key={key} selectable={selectable} style={[styles.bold, { color }]}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 1) {
      return (
        <Text key={key} selectable={selectable} style={[styles.italic, { color }]}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    return (
      <Text key={key} selectable={selectable} style={{ color }}>
        {part}
      </Text>
    );
  });
}

export function MarkdownText({ text, color = colors.textPrimary, selectable = true }: MarkdownTextProps) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let paragraphBuffer: string[] = [];
  let codeBuffer: string[] | null = null;
  let blockIndex = 0;

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) {
      return;
    }
    const joined = paragraphBuffer.join(" ");
    blocks.push(
      <Text key={`p-${blockIndex++}`} selectable={selectable} style={[styles.paragraph, { color }]}>
        {renderInline(joined, `p-${blockIndex}`, color, selectable)}
      </Text>
    );
    paragraphBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trimStart().startsWith("```")) {
      if (codeBuffer === null) {
        flushParagraph();
        codeBuffer = [];
      } else {
        blocks.push(
          <View key={`code-${blockIndex++}`} style={styles.codeBlock}>
            <Text selectable={selectable} style={styles.codeText}>{codeBuffer.join("\n")}</Text>
          </View>
        );
        codeBuffer = null;
      }
      continue;
    }
    if (codeBuffer !== null) {
      codeBuffer.push(rawLine);
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      blocks.push(
        <Text
          key={`h-${blockIndex++}`}
          selectable={selectable}
          style={[level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3, { color }]}
        >
          {headingMatch[2]}
        </Text>
      );
      continue;
    }

    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      flushParagraph();
      blocks.push(
        <View key={`li-${blockIndex++}`} style={styles.bulletRow}>
          <Text selectable={selectable} style={[styles.bulletMarker, { color }]}>{"•"}</Text>
          <Text selectable={selectable} style={[styles.bulletText, { color }]}>
            {renderInline(bulletMatch[1], `li-${blockIndex}`, color, selectable)}
          </Text>
        </View>
      );
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    paragraphBuffer.push(line);
  }
  flushParagraph();
  if (codeBuffer !== null && codeBuffer.length > 0) {
    // Unterminated fence (can happen mid-stream) — render what's there so
    // far rather than swallowing it.
    blocks.push(
      <View key={`code-${blockIndex++}`} style={styles.codeBlock}>
        <Text selectable={selectable} style={styles.codeText}>{codeBuffer.join("\n")}</Text>
      </View>
    );
  }

  return <Fragment>{blocks}</Fragment>;
}

const styles = StyleSheet.create({
  paragraph: {
    ...typography.body,
    marginBottom: spacing.xs,
  },
  h1: {
    fontSize: 19,
    fontWeight: "700",
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  h2: {
    fontSize: 17,
    fontWeight: "700",
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  h3: {
    fontSize: 15,
    fontWeight: "700",
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  bold: {
    fontWeight: "700",
  },
  italic: {
    fontStyle: "italic",
  },
  bulletRow: {
    flexDirection: "row",
    marginBottom: spacing.xs,
    paddingRight: spacing.xs,
  },
  bulletMarker: {
    marginRight: spacing.sm,
    fontSize: 15,
  },
  bulletText: {
    flex: 1,
    ...typography.body,
  },
  codeBlock: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginVertical: spacing.xs,
  },
  codeText: {
    color: colors.success,
    fontFamily: "monospace",
    fontSize: 13,
  },
});
