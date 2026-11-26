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
  ChatDetail,
  ChatMessage,
  ChatSummary,
  ClientInfo,
  GroupDetail,
  Me,
  MyClubs,
  MyGroups,
  MyWards,
  RosterEntry,
  SchedulePage,
} from "./api/queries.ts";
import type * as CarpoolModuleType from "./components/carpool.tsx";
import type * as DutiesModuleType from "./components/duties.tsx";
import { ClubProvider } from "./state/club.tsx";

type CarpoolModule = typeof CarpoolModuleType;
type DutiesModule = typeof DutiesModuleType;

const ANNA = "0199a000-0000-7000-8000-000000000001";
const ELSA = "0199a000-0000-7000-8000-000000000003";
const NADIA = "0199a000-0000-7000-8000-000000000024";
const SVK = "0199a000-0000-7000-8001-000000000001";
const F2017 = "0199a000-0000-7000-8002-000000000001";
const CHANNEL = "0199a000-0000-7000-8003-000000000001";

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

jest.mock("./api/realtime.ts", () => ({
  useRealtime: () => ({ connected: true, typing: jest.fn() }),
}));

jest.mock("./state/session.tsx", () => ({
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
  // Car-pool defaults (P2.7g): the offer form starts from them.
  client.setQueryData(["carpool", "settings", ANNA], {
    canSet: true,
    settings: { seats: 4, departurePlace: "Hemma", note: null, returnMinutes: null },
  });

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
  const inDays = (days: number, hour: number) =>
    new Date(Date.UTC(2099, 0, 1 + days, hour)).toISOString();
  const entry = (id: string, title: string, days: number, people: string[], extra = {}) => ({
    activityId: id,
    club: { id: SVK, name: "Strandvikens Volleybollklubb", timeZone: "Europe/Stockholm" },
    kind: "training",
    title,
    status: "scheduled",
    cancelledReason: null,
    startsAt: inDays(days, 16),
    endsAt: inDays(days, 17),
    allDay: false,
    meetAt: null,
    place: "Strandvikens sporthall",
    groups: [{ id: F2017, name: "F2017" }],
    people: people.map((p) =>
      p === ELSA ? summary(ELSA, "Elsa Lindqvist") : summary(ANNA, "Anna Lindqvist"),
    ),
    changed: false,
    changedAt: inDays(0, 0),
    ...extra,
  });
  const schedule = {
    items: [
      entry("a1", "Träning", 0, [ELSA]),
      entry("a2", "Styrelsemöte", 1, [ANNA], { kind: "board_retreat" }),
      entry("0199a000-0000-7000-8099-000000000003", "Match", 2, [ELSA], {
        status: "cancelled",
        cancelledReason: "Hallen är upptagen av kommunen",
      }),
      // Already over: left out.
      {
        ...entry("a0", "Gammal", 0, [ELSA]),
        startsAt: "2000-01-01T10:00:00Z",
        endsAt: "2000-01-01T11:00:00Z",
      },
    ],
    nextCursor: null,
    people: [summary(ANNA, "Anna Lindqvist"), summary(ELSA, "Elsa Lindqvist")],
  } as unknown as SchedulePage;
  client.setQueryData(["schedule", ANNA, "self"], schedule);
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
  // Chat (P2.1): a group channel with a protected member, a direct message.
  const chat = (id: string, extra: Partial<ChatSummary>): ChatSummary => ({
    id,
    clubId: SVK,
    clubName: "Strandvikens Volleybollklubb",
    kind: "channel",
    name: "F2017",
    description: null,
    visibility: "open",
    groups: [{ id: F2017, name: "F2017" }],
    defaultForGroupId: F2017,
    archived: false,
    counterpart: null,
    membership: { status: "active", push: "all", lastReadMessageId: null },
    memberCount: 3,
    hasChildren: true,
    unreadCount: 0,
    lastMessage: null,
    lastMessageAt: null,
    ...extra,
  });
  const channel = chat(CHANNEL, {
    unreadCount: 2,
    lastMessage: {
      id: "0199a000-0000-7000-8004-000000000002",
      sender: { kind: "protected" },
      kind: "text",
      excerpt: "Glöm inte knäskydden",
      createdAt: "2026-10-20T17:00:00Z",
    },
    lastMessageAt: "2026-10-20T17:00:00Z",
  });
  const direct = chat("0199a000-0000-7000-8003-000000000002", {
    kind: "direct",
    name: null,
    visibility: null,
    groups: [],
    defaultForGroupId: null,
    counterpart: { kind: "person", person: summary("c1", "Erik Johansson") },
    hasChildren: false,
  });
  client.setQueryData(["chats", ANNA], {
    pages: [{ items: [direct, channel], nextCursor: null }],
    pageParams: [null],
  });
  const chatDetail: ChatDetail = {
    chat: channel,
    members: [
      {
        personId: ANNA,
        person: { kind: "person", person: summary(ANNA, "Anna Lindqvist") },
        status: "active",
        reason: "group",
        role: "member",
        child: false,
        leader: false,
        guardianOf: [],
        joinedAt: "2026-10-01T10:00:00Z",
        lastReadMessageId: null,
      },
    ],
    hiddenMembers: 1,
    can: { post: true, join: false, leave: false, manage: false },
  };
  client.setQueryData(["chat", ANNA, CHANNEL], chatDetail);
  const message = (id: string, extra: Partial<ChatMessage>): ChatMessage => ({
    id,
    chatId: CHANNEL,
    kind: "text",
    sender: { kind: "person", person: summary(ANNA, "Anna Lindqvist") },
    senderId: ANNA,
    body: "",
    event: null,
    replyTo: null,
    createdAt: "2026-10-20T16:00:00Z",
    editedAt: null,
    hidden: null,
    reactions: [],
    ...extra,
  });
  client.setQueryData(["chat", ANNA, CHANNEL, "messages"], {
    pages: [
      {
        items: [
          message("0199a000-0000-7000-8004-000000000002", {
            sender: { kind: "protected" },
            senderId: null,
            body: "Glöm inte knäskydden",
            reactions: [{ emoji: "👍", count: 2, mine: true }],
          }),
          message("0199a000-0000-7000-8004-000000000001", { body: "Träning 17:00" }),
        ],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
  // "Mina dokument" (P2.2): a new clean file and one still being scanned.
  const file = (id: string, name: string, status: string) => ({
    id,
    clubId: SVK,
    folderId: "0199a000-0000-7000-8005-000000000001",
    kind: "file",
    name,
    current:
      status === "clean"
        ? { id: `${id.slice(0, -1)}9`, number: 1, size: 2048, status, fileName: name }
        : null,
    latest: status === "clean" ? null : { status },
    ownAudience: false,
    updatedAt: "2026-10-20T16:00:00Z",
    publishedAt: "2026-10-20T16:00:00Z",
    deleteAfter: null,
  });
  client.setQueryData(["documents", ANNA, "mine"], {
    pages: [
      {
        items: [
          {
            document: file("0199a000-0000-7000-8006-000000000001", "Matchschema.pdf", "clean"),
            clubName: "Strandvikens Volleybollklubb",
            groupId: F2017,
            groupName: "F2017",
            isNew: true,
          },
          {
            document: file("0199a000-0000-7000-8006-000000000002", "Kallelse.pdf", "pending"),
            clubName: "Strandvikens Volleybollklubb",
            groupId: null,
            groupName: null,
            isNew: false,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
  // "Anslagstavlan" (P2.3): a pinned club announcement and an unread group one.
  const announcement = (id: string, extra: Record<string, unknown>) => ({
    id,
    clubId: SVK,
    clubName: "Strandvikens Volleybollklubb",
    groupId: null,
    groupName: null,
    title: "",
    body: "",
    channels: ["board"],
    important: false,
    status: "sent",
    pinned: false,
    pinnedUntil: null,
    expiresAt: null,
    scheduledAt: null,
    sentAt: "2026-10-20T16:00:00Z",
    editedAt: null,
    sender: null,
    read: true,
    canManage: false,
    ...extra,
  });
  // "Mina samåkningar" (P2.5): Anna drives; Elsa's seat home waits for her confirmation.
  client.setQueryData(["carpool", "mine", ANNA], {
    items: [
      {
        clubId: SVK,
        clubName: "Strandvikens Volleybollklubb",
        activityId: "0199a000-0000-7000-8099-000000000003",
        activityTitle: "Bortamatch",
        startsAt: "2030-05-04T08:00:00Z",
        offerId: "0199a000-0000-7000-8016-000000000002",
        direction: "back",
        driving: false,
        bookingId: "0199a000-0000-7000-8017-000000000001",
        passenger: summary(ELSA, "Elsa Lindqvist"),
        status: "pending_guardian",
        driver: summary(NADIA, "Erik Johansson"),
      },
      {
        clubId: SVK,
        clubName: "Strandvikens Volleybollklubb",
        activityId: "0199a000-0000-7000-8099-000000000003",
        activityTitle: "Bortamatch",
        startsAt: "2030-05-04T08:00:00Z",
        offerId: "0199a000-0000-7000-8016-000000000001",
        direction: "out",
        driving: true,
        bookingId: null,
        passenger: null,
        status: null,
        driver: null,
      },
    ],
  });
  client.setQueryData(["announcements", ANNA, "board"], {
    pages: [
      {
        pinned: [
          announcement("0199a000-0000-7000-8007-000000000001", {
            title: "Årsmöte 12 mars",
            body: "**Välkomna** till årsmötet.",
            important: true,
            pinned: true,
          }),
        ],
        items: [
          announcement("0199a000-0000-7000-8007-000000000002", {
            title: "Planen är stängd",
            body: "Ingen träning tisdag.",
            groupId: F2017,
            groupName: "F2017",
            read: false,
          }),
        ],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
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
    const Home = (require("./app/(app)/(tabs)/home.tsx") as { default: () => ReactNode }).default;
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
    const Group = (require("./app/(app)/groups/[groupId].tsx") as { default: () => ReactNode })
      .default;
    renderScreen(<Group />);
    expect(screen.getByText("Sara Ahmed")).toBeTruthy();
    expect(screen.getAllByText("Erik Johansson").length).toBeGreaterThan(0);
    expect(screen.getByTestId(`person-${NADIA}`)).toBeTruthy();
    expect(screen.getAllByTestId("protected-badge")).toHaveLength(1);
    expect(screen.getByText("3 members")).toBeTruthy();
    // Unknown kind and function from a newer server.
    expect(screen.getAllByText("Other").length).toBeGreaterThanOrEqual(2);
  });

  it("My schedule groups the coming activities by day, with whose they are and cancellations", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Schedule = (require("./app/(app)/(tabs)/schedule.tsx") as { default: () => ReactNode })
      .default;
    renderScreen(<Schedule />);
    expect(screen.getByTestId("schedule-item-a1")).toBeTruthy();
    expect(screen.getByTestId("schedule-item-0199a000-0000-7000-8099-000000000003")).toBeTruthy();
    expect(screen.queryByTestId("schedule-item-a0")).toBeNull();
    expect(screen.getByText("Hallen är upptagen av kommunen")).toBeTruthy();
    expect(screen.getByTestId(`schedule-person-${ELSA}`)).toBeTruthy();
    // An activity kind this app version does not know.
    expect(screen.getAllByText("Other").length).toBeGreaterThan(0);
  });

  it("an activity shows the schedule's cached entry before its details arrive", () => {
    mockParams = { activityId: "0199a000-0000-7000-8099-000000000003" };
    type Module = { default: () => ReactNode };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Activity = (require("./app/(app)/activities/[activityId].tsx") as Module).default;
    renderScreen(<Activity />);
    expect(screen.getByTestId("activity-screen")).toBeTruthy();
    expect(screen.getAllByText("Match").length).toBeGreaterThan(0);
    expect(screen.getByText("Cancelled: Hallen är upptagen av kommunen")).toBeTruthy();
    expect(screen.getByText("Strandvikens sporthall")).toBeTruthy();
  });

  it("My channels lists unread first, with people only as the API presented them", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Chats = (require("./app/(app)/(tabs)/chats.tsx") as { default: () => ReactNode }).default;
    renderScreen(<Chats />);
    const rows = screen.getAllByTestId(/^chat-0199/);
    expect(rows[0]?.props.testID).toBe(`chat-${CHANNEL}`);
    expect(screen.getByText("Erik Johansson")).toBeTruthy();
    expect(screen.getByText("A member with protected identity: Glöm inte knäskydden")).toBeTruthy();
    expect(screen.getByTestId(`chat-unread-${CHANNEL}`)).toBeTruthy();
  });

  it("a chat shows its cached messages at once, oldest at the top", () => {
    mockParams = { clubId: SVK, chatId: CHANNEL };
    type Module = { default: () => ReactNode };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Chat = (require("./app/(app)/chats/[clubId]/[chatId].tsx") as Module).default;
    renderScreen(<Chat />);
    expect(screen.getByText("Träning 17:00")).toBeTruthy();
    expect(screen.getByText("Glöm inte knäskydden")).toBeTruthy();
    expect(screen.getByText("A member with protected identity")).toBeTruthy();
    expect(screen.getByText("👍 2")).toBeTruthy();
    expect(screen.getByTestId("chat-input")).toBeTruthy();
  });

  it("My documents shows the cached files at once, new ones marked and unscanned ones' state", () => {
    type Module = { default: () => ReactNode };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Documents = (require("./app/(app)/documents/index.tsx") as Module).default;
    renderScreen(<Documents />);
    expect(screen.getByTestId("document-0199a000-0000-7000-8006-000000000001")).toBeTruthy();
    expect(screen.getByText(/Matchschema\.pdf/)).toBeTruthy();
    expect(screen.getByText("F2017 · 2 kB")).toBeTruthy();
    expect(screen.getAllByTestId("document-new")).toHaveLength(1);
    expect(screen.getByText("Strandvikens Volleybollklubb · Being scanned")).toBeTruthy();
  });

  it("the notice board shows the cached announcements at once, pinned on top, unread marked", () => {
    type Module = { default: () => ReactNode };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Board = (require("./app/(app)/(tabs)/announcements.tsx") as Module).default;
    renderScreen(<Board />);
    const rows = screen.getAllByTestId(/^announcement-0199/);
    expect(rows[0]?.props.testID).toBe("announcement-0199a000-0000-7000-8007-000000000001");
    expect(screen.getByText("Årsmöte 12 mars")).toBeTruthy();
    expect(screen.getByText("Välkomna till årsmötet.")).toBeTruthy();
    expect(screen.getAllByTestId("announcement-unread")).toHaveLength(1);
  });

  it("Mina samåkningar shows the cached list at once, asking to confirm a child's seat", () => {
    type Module = { default: () => ReactNode };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Carpools = (require("./app/(app)/carpools/index.tsx") as Module).default;
    renderScreen(<Carpools />);
    expect(screen.getAllByTestId("my-carpool")).toHaveLength(2);
    expect(screen.getByText("You drive")).toBeTruthy();
    expect(
      screen.getByText("Elsa Lindqvist is the only child with Erik Johansson. Do you approve?"),
    ).toBeTruthy();
    expect(screen.getByTestId("carpool-confirm-0199a000-0000-7000-8017-000000000001")).toBeTruthy();
  });

  it("an activity's car pool shows the cars, the note, free seats and who has no ride", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const { CarpoolSection } = require("./components/carpool.tsx") as CarpoolModule;
    const offer = {
      id: "0199a000-0000-7000-8016-000000000001",
      direction: "out" as const,
      outwardOfferId: null,
      driver: summary(NADIA, "Erik Johansson"),
      mine: false,
      willingOnly: false,
      seats: 3,
      freeSeats: 2,
      departurePlace: "Norrbacka IP",
      note: "Plats för bollbag",
      departureAt: null,
      distanceKm: 38,
      bookings: [
        {
          id: "0199a000-0000-7000-8017-000000000002",
          passenger: null,
          status: "held" as const,
          canCancel: false,
          canConfirm: false,
        },
      ],
    };
    renderScreen(
      <CarpoolSection
        activityId="0199a000-0000-7000-8099-000000000003"
        timeZone="Europe/Stockholm"
        open
        carpool={
          {
            activityId: "0199a000-0000-7000-8099-000000000003",
            transportMode: "own",
            distanceKm: 38,
            offers: [offer],
            canOffer: true,
            canBookFor: [summary(ELSA, "Elsa Lindqvist")],
            withoutRide: [summary(NADIA, "Sara Ahmed")],
            withoutRideHidden: 1,
            // A booking without a name (the viewer may not see who rides).
          } as unknown as Parameters<typeof CarpoolSection>[0]["carpool"]
        }
      />,
    );
    expect(screen.getByText("Plats för bollbag")).toBeTruthy();
    expect(screen.getByText("2 of 3 seats free")).toBeTruthy();
    expect(screen.getByText("Seat booked")).toBeTruthy();
    expect(screen.getByText("No cars yet.")).toBeTruthy();
    expect(screen.getByText("Sara Ahmed and 1 more")).toBeTruthy();
    expect(screen.getByTestId(`carpool-book-${offer.id}-${ELSA}`)).toBeTruthy();
    expect(screen.getByTestId("carpool-offer-submit")).toBeTruthy();
    // The offer starts from my defaults (P2.7g).
    expect(screen.getByDisplayValue("Hemma")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("Mina uppgifter's duties show quotas, an offered shift to take and open shifts", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const { MyDutiesSections } = require("./components/duties.tsx") as DutiesModule;
    const shift = {
      id: "0199a000-0000-7000-8018-000000000001",
      clubId: SVK,
      groupId: F2017,
      groupName: "F2017",
      dutyType: {
        id: "0199a000-0000-7000-8019-000000000001",
        name: "Kiosk",
        minAge: 13,
        childContact: "with_children" as const,
      },
      title: "Kiosk – hemmamatch",
      note: "Hemmamatch",
      startsAt: "2030-05-04T12:30:00Z",
      endsAt: "2030-05-04T15:00:00Z",
      timeZone: "Europe/Stockholm",
      locationId: null,
      locationName: null,
      activityId: null,
      eventId: null,
      needed: 2,
      filled: 1,
      assignments: [
        {
          id: "0199a000-0000-7000-8020-000000000001",
          person: null,
          countsFor: null,
          source: "signup" as const,
          status: "planned" as const,
          mine: false,
        },
      ],
    };
    renderScreen(
      <MyDutiesSections
        duties={
          {
            clubId: SVK,
            quotas: [
              {
                groupId: F2017,
                groupName: "F2017",
                seasonId: "0199a000-0000-7000-8021-000000000001",
                player: summary(ELSA, "Elsa Lindqvist"),
                shiftsPerPlayer: 2,
                done: 1,
                planned: 0,
              },
            ],
            openShifts: [shift],
            swaps: [
              {
                id: "0199a000-0000-7000-8022-000000000001",
                kind: "offer",
                status: "open",
                assignmentId: "0199a000-0000-7000-8020-000000000001",
                shift: { ...shift },
                holder: null,
                taker: null,
                mine: false,
                canTake: true,
                canAccept: false,
              },
            ],
          } as unknown as Parameters<typeof MyDutiesSections>[0]["duties"]
        }
      />,
    );
    expect(screen.getByText("1 done, 0 planned of 2")).toBeTruthy();
    expect(screen.getByText("Offered: Kiosk – hemmamatch")).toBeTruthy();
    expect(screen.getByTestId("duty-swap-take-0199a000-0000-7000-8022-000000000001")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("Someone")).toBeTruthy();
    expect(screen.getByText("Sign up (counts for Elsa Lindqvist)")).toBeTruthy();
  });

  it("an invalid ID in a deep link shows not found", () => {
    mockParams = { groupId: "../../etc/passwd" };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks
    const Group = (require("./app/(app)/groups/[groupId].tsx") as { default: () => ReactNode })
      .default;
    renderScreen(<Group />);
    expect(screen.getByText("Not found")).toBeTruthy();
  });
});
