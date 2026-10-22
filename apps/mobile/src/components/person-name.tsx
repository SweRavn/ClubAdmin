// SPDX-License-Identifier: AGPL-3.0-only
// The only way the app shows a person (ADR 0022): a PersonSummary from the
// API, as text from personLabel (packages/shared), with the protected icon
// when the API marked the person protected. People the viewer may not see
// never reach the app.

import { type Exactly, personLabel, type PersonSummary } from "@clubadmin/shared";
import { type Href, Link } from "expo-router";
import type { ReactNode } from "react";
import { Text, View } from "react-native";

import { useTheme } from "../theme.ts";
import { ProtectedBadge } from "./protected-badge.tsx";

export function PersonName<P extends PersonSummary>({
  person,
  href,
  children,
}: {
  person: Exactly<PersonSummary, P>;
  /** The person's profile. */
  href?: Href;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const name = personLabel(person);
  const text = (
    <Text
      style={{
        color: href ? theme.colors.accent : theme.colors.fg,
        fontSize: 16,
        fontWeight: "600",
      }}
    >
      {name}
    </Text>
  );
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}
      testID={`person-${person.id}`}
    >
      {href ? (
        <Link
          href={href}
          accessibilityRole="link"
          style={{ minHeight: theme.touch, paddingVertical: 10 }}
        >
          {text}
        </Link>
      ) : (
        text
      )}
      {person.protected ? <ProtectedBadge /> : null}
      {children}
    </View>
  );
}
