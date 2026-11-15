// SPDX-License-Identifier: AGPL-3.0-only
// The shared Markdown subset (P2.3, ADR 0053) as native text: the tree from
// @clubadmin/shared, never HTML. Links (https or mailto, checked by the
// parser) open outside the app. Headings and, for governing documents
// (`settings`), settings markers (P2.4), shown as their marked value.
import { type MarkdownInline, parseMarkdown } from "@clubadmin/shared";
import type { ReactNode } from "react";
import { Linking, Text, View } from "react-native";

import { useTheme } from "../theme.ts";

function Inline({ nodes }: { nodes: readonly MarkdownInline[] }): ReactNode {
  const theme = useTheme();
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "break":
        return "\n";
      case "strong":
        return (
          <Text key={i} style={{ fontWeight: "700" }}>
            <Inline nodes={n.children} />
          </Text>
        );
      case "em":
        return (
          <Text key={i} style={{ fontStyle: "italic" }}>
            <Inline nodes={n.children} />
          </Text>
        );
      case "link":
        return (
          <Text
            key={i}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(n.href)}
            style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
          >
            <Inline nodes={n.children} />
          </Text>
        );
      case "setting":
        return (
          <Text key={i} style={{ fontWeight: "600", backgroundColor: theme.colors.accentSoft }}>
            {n.value}
          </Text>
        );
    }
  });
}

const HEADING_SIZE = { 1: 22, 2: 19, 3: 17 } as const;

export function Markdown({
  source,
  testID,
  settings = false,
}: {
  source: string;
  testID?: string;
  /** Show settings markers (governing documents). */
  settings?: boolean;
}) {
  const theme = useTheme();
  const text = { color: theme.colors.fg, fontSize: 16, lineHeight: 22 };
  return (
    <View style={{ gap: theme.space(2) }} testID={testID}>
      {parseMarkdown(source, { settings }).map((block, i) =>
        block.type === "heading" ? (
          <Text
            key={i}
            accessibilityRole="header"
            style={{
              ...text,
              fontSize: HEADING_SIZE[block.level],
              lineHeight: HEADING_SIZE[block.level] + 6,
              fontWeight: "700",
            }}
          >
            <Inline nodes={block.children} />
          </Text>
        ) : block.type === "paragraph" ? (
          <Text key={i} style={text}>
            <Inline nodes={block.children} />
          </Text>
        ) : (
          <View key={i} style={{ gap: theme.space(1) }}>
            {block.items.map((item, j) => (
              <Text key={j} style={text}>
                {block.ordered ? `${j + 1}. ` : "• "}
                <Inline nodes={item} />
              </Text>
            ))}
          </View>
        ),
      )}
    </View>
  );
}
