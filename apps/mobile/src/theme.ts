// SPDX-License-Identifier: AGPL-3.0-only
// Colours and spacing for light and dark mode, matching the web tokens
// (packages/ui/src/tokens.css). Contrast ≥ 4.5:1 for text on its background.

import { createContext, createElement, type ReactNode, useContext } from "react";
import { useColorScheme } from "react-native";

export interface Theme {
  dark: boolean;
  colors: {
    bg: string;
    surface: string;
    fg: string;
    muted: string;
    border: string;
    accent: string;
    accentFg: string;
    accentSoft: string;
    warning: string;
    warningFg: string;
    danger: string;
  };
  space: (n: number) => number;
  /** Minimum touch target (pt). */
  touch: number;
}

const space = (n: number) => n * 4;

const light: Theme = {
  dark: false,
  colors: {
    bg: "#f7f8fa",
    surface: "#ffffff",
    fg: "#16202c",
    muted: "#4f5d6d",
    border: "#d4d9e0",
    accent: "#1f4e79",
    accentFg: "#ffffff",
    accentSoft: "#e3edf7",
    warning: "#fff4d6",
    warningFg: "#5c4300",
    danger: "#a3241b",
  },
  space,
  touch: 44,
};

const dark: Theme = {
  dark: true,
  colors: {
    bg: "#0f151c",
    surface: "#18212c",
    fg: "#eef2f6",
    muted: "#a9b4c0",
    border: "#2c3a4a",
    accent: "#8cc2f2",
    accentFg: "#0b1a29",
    accentSoft: "#1d3046",
    warning: "#3d3010",
    warningFg: "#ffe3a3",
    danger: "#ff8a80",
  },
  space,
  touch: 44,
};

export type ThemePreference = "light" | "dark" | "system" | null | undefined;

export function themeFor(preference: ThemePreference, system: string | null | undefined) {
  const mode = preference === "light" || preference === "dark" ? preference : system;
  return mode === "dark" ? dark : light;
}

const ThemeContext = createContext<ThemePreference>(null);

/** The user's theme preference (GET /me) for everything below. */
export function ThemeProvider({
  preference,
  children,
}: {
  preference: ThemePreference;
  children: ReactNode;
}) {
  return createElement(ThemeContext.Provider, { value: preference }, children);
}

export function useTheme(): Theme {
  const system = useColorScheme();
  return themeFor(useContext(ThemeContext), system);
}
