// SPDX-License-Identifier: AGPL-3.0-only
import { catalogues, enumKey, withFallback } from "@clubadmin/i18n";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { IntlProvider, useTranslations } from "use-intl";

import type { Group } from "../api/queries.ts";
import { groupTree } from "./group-tree.ts";
import { PersonName } from "./person-name.tsx";
import { RoleBadge } from "./role-badge.tsx";

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));

const wrap = (node: ReactNode, locale: "sv" | "en" = "en") => (
  <IntlProvider locale={locale} timeZone="Europe/Stockholm" messages={withFallback(locale)}>
    {node}
  </IntlProvider>
);

const person = (overrides: Partial<{ protected: boolean }> = {}) => ({
  id: "0192c0de-0000-7000-8000-000000000001",
  displayName: "Nadia Berg",
  givenName: "Nadia",
  familyName: "Berg",
  protected: false,
  ...overrides,
});

describe("PersonName", () => {
  it("shows the name without an icon for an ordinary person", () => {
    render(wrap(<PersonName person={person()} />));
    expect(screen.getByText("Nadia Berg")).toBeTruthy();
    expect(screen.queryByTestId("protected-badge")).toBeNull();
  });

  it("shows the crossed-camera icon for a protected person, with its explanation", () => {
    render(wrap(<PersonName person={person({ protected: true })} />, "sv"));
    const badge = screen.getByTestId("protected-badge");
    const label = (catalogues.sv.protected as Record<string, string>).tooltip!;
    expect(badge.props.accessibilityLabel).toBe(label);
    fireEvent.press(badge);
    expect(screen.getByText(label)).toBeTruthy();
  });
});

function KindLabel({ kind }: { kind: string }) {
  const t = useTranslations();
  return <RoleBadge label={t(enumKey("kinds", kind))} />;
}

describe("values a newer API adds (ADR 0029)", () => {
  it("shows an unknown enum value as 'Other' instead of failing", () => {
    render(wrap(<KindLabel kind="esports_team" />, "sv"));
    expect(screen.getByText("Övrigt")).toBeTruthy();
  });

  it("builds the group tree from responses with unknown fields and kinds", () => {
    const group = (id: string, parentGroupId: string | null, name: string) =>
      ({
        id,
        clubId: "c",
        parentGroupId,
        kind: "brand_new_kind",
        name,
        addedByANewerServer: { anything: true },
      }) as unknown as Group;
    const tree = groupTree([
      group("t2", "s", "P2014"),
      group("s", null, "Fotboll"),
      group("t1", "s", "F2016"),
      // Its parent is not visible to this viewer: shown at the top level.
      group("x", "hidden", "Styrelsen"),
    ]);
    expect(tree.map(({ group: g, depth }) => `${depth}:${g.name}`)).toEqual([
      "0:Fotboll",
      "1:F2016",
      "1:P2014",
      "0:Styrelsen",
    ]);
  });
});
