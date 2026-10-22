// SPDX-License-Identifier: AGPL-3.0-only
// A small label for a club role, group function or kind ("Head coach").

import { Text } from "react-native";

import { useTheme } from "../theme.ts";

export function RoleBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "accent";
}) {
  const theme = useTheme();
  const accent = tone === "accent";
  return (
    <Text
      style={{
        fontSize: 13,
        fontWeight: "500",
        color: accent ? theme.colors.fg : theme.colors.muted,
        backgroundColor: accent ? theme.colors.accentSoft : "transparent",
        borderColor: theme.colors.border,
        borderWidth: accent ? 0 : 1,
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        overflow: "hidden",
      }}
    >
      {label}
    </Text>
  );
}
