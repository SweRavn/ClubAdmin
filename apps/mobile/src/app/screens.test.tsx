// SPDX-License-Identifier: AGPL-3.0-only
// The main screens render from (cached) query data as the API returns it,
// including what a newer server might add (ADR 0029), with the protected
// icon where the API marked a person protected.

import { withFallback } from "@clubadmin/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { IntlProvider } from "use-intl";

import type {
  ClientInfo,
  GroupDetail,
  Me,
  MyClubs,
  MyGroups,
  MyWards,
  RosterEntry,
} from "../api/queries.ts";
import { ClubProvider } from "../state/club.tsx";

const ANNA = "0199a000-0000-7000-8000-000000000001";
const ELSA = "0199a000-0000-7000-8000-000000000003";
const NADIA = "0199a000-0000-7000-8000-000000000024";
const SVK = "0199a000-0000-7000-8001-000000000001";
const F2017 = "0199a000-0000-7000-8002-000000000001";

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => {
  const Stack = Object.assign(({ children }: { children?: ReactNode }) => children ?? null, {
    Screen: () => null,
  });
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    Redirect: () => null,
    Stack,
    router: { push: jest.fn(), replace: jest.fn() },
    useLocalSearchParams: () => mockParams,
    useFocusEffect: () => undefined,
  };
});

jest.mock("../state/session.tsx", () => ({
  useSession: () => ({
    status: "signedIn",
    personId: "0199a000-0000-7000-8000-000000000001",
    viewingAs: null,
    setViewingAs: jest.fn(),
    api: {},
    signIn: jest.fn(),
    signInAsPersona: jest.fn(),
    signOut: jest.fn(),
    setAcceptLanguage: jest.fn(),
  }),
}));

const summary = (id: string, name: string, isProtected = false) => {
  const [givenName = "", familyName = ""] = name.split(" ");
  return { id, displayName: name, givenName, familyName, protected: isProtected };
};

const group = (id: string, name: string, kind: string) =>
  ({
    id,
    clubId: SVK,
    parentGroupId: null,
    kind,
    name,
    sport: "volleyball",
    birthYearFrom: 2017,
    birthYearTo: 2017,
    genderCategory: "female",
    level: null,
    capacity: 16,
    admissionMode: "approval",
    archived: false,
    // Something a newer server added:
    colour: "#ff0000",
  }) as unknown as GroupDetail;

function seededClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  });
  const me = {
    personId: ANNA,
    accountId: "a",
    person: summary(ANNA, "Anna Lindqvist"),
    mfa: false,
    preferences: { locale: null, timeZone: null, theme: null },
  } as unknown as Me;
  const clubs = {
    clubs: [
      {
        club: {
          id: SVK,
          name: "Strandvikens Volleybollklubb",
          shortName: "SVK",
          slug: "svk",
          country: "SE",
          logo: null,
          defaultLocale: "sv",
          timeZone: "Europe/Stockholm",
        },
        membership: { status: "active", membershipType: "active" },
        roles: ["chair", "club_manager", "brand_new_role"],
        permissions: [],
      },
    ],
  } as unknown as MyClubs;
  const groups = {
    groups: [
      {
        group: group(F2017, "F2017", "team"),
        club: { id: SVK, name: "Strandvikens Volleybollklubb" },
        functions: ["member"],
      },
    ],
    wards: [
      {
        personId: ELSA,
        groups: [
          {
            group: group(F2017, "F2017", "team"),
            club: { id: SVK, name: "Strandvikens Volleybollklubb" },
            functions: ["member"],
          },
        ],
      },
    ],
  } as unknown as MyGroups;
  const wards = {
    wards: [
      {
        person: summary(ELSA, "Elsa Lindqvist"),
        kind: "parent",
        rights: ["act_on_behalf", "see_medical"],
      },
    ],
  } as unknown as MyWards;
  client.setQueryData(["me", ANNA], me);
  client.setQueryData(["clubs", ANNA, "self"], clubs);
  client.setQueryData(["groups", ANNA, "self"], groups);
  client.setQueryData(["me", ANNA, "wards"], wards);

  const detail = {
    ...group(F2017, "F2017", "esports_squad"),
    owners: [summary("o1", "Sara Ahmed")],
  };
  const roster: RosterEntry[] = [
    { person: summary("c1", "Erik Johansson"), functions: ["head_coach"] },
    { person: summary(NADIA, "Nadia Karimi", true), functions: ["member"] },
    { person: summary("m2", "Maja Johansson"), functions: ["member", "kit_manager" as "member"] },
  ];
  client.setQueryData(["group", F2017, ANNA, "self"], detail);
  client.setQueryData(["group", F2017, "members", ANNA, "self"], {
    pages: [{ items: roster, nextCursor: null, totalCount: 3 }],
    pageParams: [null],
  });
  const info: ClientInfo = {
    apiVersion: 1,
    serverVersion: "1.0.0",
    apps: {
      ios: { minimumVersion: "0.0.0", recommendedVersion: "0.0.0", storeUrl: null },
      android: { minimumVersion: "0.0.0", recommendedVersion: "0.0.0", storeUrl: null },
    },
    features: ["me.preferences", "sessions.mobile"],
    flags: {},
  };
  client.setQueryData(["meta", "client"], info);
  return client;
}

function renderScreen(node: ReactNode) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={seededClient()}>
        <IntlProvider locale="en" timeZone="Europe/Stockholm" messages={withFallback("en")}>
          <ClubProvider>{node}</ClubProvider>
        </IntlProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

describe("screens", () => {
  it("Home shows clubs, roles, groups, the ward's groups and the viewing-as switcher", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Home = (require("./(app)/home.tsx") as { default: () => ReactNode }).default;
    renderScreen(<Home />);
    expect(screen.getByText("Hi Anna Lindqvist")).toBeTruthy();
    expect(screen.getAllByText("Strandvikens Volleybollklubb").length).toBeGreaterThan(0);
    expect(screen.getByText("Chair")).toBeTruthy();
    // A role this app version does not know.
    expect(screen.getByText("Other")).toBeTruthy();
    expect(screen.getByText("Elsa Lindqvist's groups")).toBeTruthy();
    expect(screen.getByTestId(`viewing-as-${ELSA}`)).toBeTruthy();
  });

  it("Group shows owners, leaders and members with the protected icon, tolerating new values", () => {
    mockParams = { groupId: F2017 };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Group = (require("./(app)/groups/[groupId].tsx") as { default: () => ReactNode }).default;
    renderScreen(<Group />);
    expect(screen.getByText("Sara Ahmed")).toBeTruthy();
    expect(screen.getAllByText("Erik Johansson").length).toBeGreaterThan(0);
    expect(screen.getByTestId(`person-${NADIA}`)).toBeTruthy();
    expect(screen.getAllByTestId("protected-badge")).toHaveLength(1);
    expect(screen.getByText("3 members")).toBeTruthy();
    // Unknown kind and function from a newer server.
    expect(screen.getAllByText("Other").length).toBeGreaterThanOrEqual(2);
  });

  it("an invalid ID in a deep link shows not found", () => {
    mockParams = { groupId: "../../etc/passwd" };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Group = (require("./(app)/groups/[groupId].tsx") as { default: () => ReactNode }).default;
    renderScreen(<Group />);
    expect(screen.getByText("Not found")).toBeTruthy();
  });
});
