// SPDX-License-Identifier: AGPL-3.0-only
// Layout primitives: screen, section, row, button, empty state. Text comes
// from the message catalogues; touch targets are at least 44 pt and text
// scales with the system font size.

import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../theme.ts";

export function Screen({
  children,
  refreshing,
  onRefresh,
  testID,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      contentContainerStyle={{
        padding: theme.space(4),
        paddingBottom: theme.space(4) + insets.bottom,
        gap: theme.space(5),
      }}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} />
        ) : undefined
      }
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

export function Heading({ children, level = 1 }: { children: ReactNode; level?: 1 | 2 }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: theme.colors.fg,
        fontSize: level === 1 ? 24 : 18,
        fontWeight: "700",
      }}
    >
      {children}
    </Text>
  );
}

export function Muted({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: TextStyle;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Text style={[{ color: theme.colors.muted, fontSize: 14 }, style]} testID={testID}>
      {children}
    </Text>
  );
}

export function Body({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const theme = useTheme();
  return <Text style={[{ color: theme.colors.fg, fontSize: 16 }, style]}>{children}</Text>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space(2) }}>
      <Heading level={2}>{title}</Heading>
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: theme.space(3),
        }}
      >
        {children}
      </View>
    </View>
  );
}

export function Row({
  children,
  onPress,
  accessibilityLabel,
  last,
  testID,
}: {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  last?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const style: ViewStyle = {
    minHeight: theme.touch,
    paddingVertical: theme.space(2),
    borderBottomWidth: last ? 0 : 1,
    borderBottomColor: theme.colors.border,
    justifyContent: "center",
    gap: theme.space(1),
  };
  if (!onPress) {
    return (
      <View style={style} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      style={({ pressed }) => [style, pressed ? { opacity: 0.6 } : null]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  kind = "primary",
  disabled,
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const primary = kind === "primary";
  const color = primary
    ? theme.colors.accentFg
    : kind === "danger"
      ? theme.colors.danger
      : theme.colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      testID={testID}
      style={({ pressed }) => ({
        minHeight: theme.touch,
        paddingHorizontal: theme.space(4),
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: theme.space(2),
        backgroundColor: primary ? theme.colors.accent : "transparent",
        borderWidth: primary ? 0 : 1,
        borderColor: kind === "danger" ? theme.colors.danger : theme.colors.border,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={color} /> : null}
      <Text style={{ color, fontSize: 16, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  const theme = useTheme();
  return (
    <View style={{ paddingVertical: theme.space(4), gap: theme.space(1) }}>
      <Body style={{ fontWeight: "600" }}>{title}</Body>
      {body ? <Muted>{body}</Muted> : null}
    </View>
  );
}

export function Loading({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space(8) }}
      accessibilityLabel={label}
      accessible
    >
      <ActivityIndicator color={theme.colors.accent} />
    </View>
  );
}

export function Banner({
  children,
  tone = "info",
  action,
  testID,
}: {
  children: ReactNode;
  tone?: "info" | "warning";
  action?: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  const warning = tone === "warning";
  return (
    <View
      accessibilityRole="alert"
      testID={testID}
      style={{
        backgroundColor: warning ? theme.colors.warning : theme.colors.accentSoft,
        paddingHorizontal: theme.space(4),
        paddingVertical: theme.space(2),
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space(3),
      }}
    >
      <Text style={{ flex: 1, color: warning ? theme.colors.warningFg : theme.colors.fg }}>
        {children}
      </Text>
      {action}
    </View>
  );
}

export function LinkButton({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={12}
      testID={testID}
      style={{ minHeight: theme.touch, justifyContent: "center" }}
    >
      <Text style={{ color: theme.colors.accent, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
