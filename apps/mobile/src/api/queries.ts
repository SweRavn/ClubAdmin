// SPDX-License-Identifier: AGPL-3.0-only
// Data hooks over the typed client. Keys include the ward when viewing as
// one, so a guardian's and a ward's data never mix in the cache. Responses
// are used as the generated types describe them, never parsed strictly:
// unknown fields and enum values from a newer server are tolerated (ADR 0029).

import type { ApiClient, components } from "@clubadmin/api-client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "../state/session.tsx";

export type Schemas = components["schemas"];
export type Me = Schemas["Me"];
export type MyClubs = Schemas["MyClubs"];
export type MyClub = MyClubs["clubs"][number];
export type MyGroups = Schemas["MyGroups"];
export type MyWards = Schemas["MyWards"];
export type ClubDetail = Schemas["ClubDetail"];
export type Group = Schemas["Group"];
export type GroupDetail = Schemas["GroupDetail"];
export type RosterEntry = Schemas["GroupMemberList"]["items"][number];
export type PersonProfile = Schemas["PersonProfile"];
export type SessionEntry = Schemas["SessionList"]["sessions"][number];
export type ClientInfo = Schemas["ClientInfoResponse"];
export type Preferences = Schemas["Preferences"];

/** Unwraps an openapi-fetch result (errors are thrown by the client's middleware). */
function data<T>(result: { data?: T }): T {
  if (result.data === undefined) throw new Error("empty response");
  return result.data;
}

/** The logged-in person's own data (never on behalf of a ward). */
export function useMe() {
  const { api, personId } = useSession();
  return useQuery({
    queryKey: ["me", personId],
    queryFn: async () => data(await api.GET("/api/v1/me")),
    enabled: personId !== null,
  });
}

export function useMyWards() {
  const { api, personId } = useSession();
  return useQuery({
    queryKey: ["me", personId, "wards"],
    queryFn: async () => data(await api.GET("/api/v1/me/wards")),
    enabled: personId !== null,
  });
}

export type WardGuardians = Schemas["WardGuardians"];

/** A ward's guardians, relatives and contact persons (P1.3, read-only in the app). */
export function useWardGuardians(wardId: string) {
  const { api, personId } = useSession();
  return useQuery({
    queryKey: ["me", personId, "wards", wardId, "guardians"],
    queryFn: async () =>
      data(
        await api.GET("/api/v1/me/wards/{personId}/guardians", {
          params: { path: { personId: wardId } },
        }),
      ),
    enabled: personId !== null,
  });
}

/** Keys for data that follows "viewing as". */
export function useScope() {
  const { personId, viewingAs } = useSession();
  return [personId, viewingAs ?? "self"] as const;
}

export function useMyClubs() {
  const { api, personId } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["clubs", ...scope],
    queryFn: async () => data(await api.GET("/api/v1/me/clubs")),
    enabled: personId !== null,
  });
}

export function useMyGroups() {
  const { api, personId } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["groups", ...scope],
    queryFn: async () => data(await api.GET("/api/v1/me/groups")),
    enabled: personId !== null,
  });
}

export function useClub(clubId: string) {
  const { api } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["club", clubId, ...scope],
    queryFn: async () =>
      data(await api.GET("/api/v1/clubs/{clubId}", { params: { path: { clubId } } })),
  });
}

export function useClubGroups(clubId: string | null) {
  const { api } = useSession();
  const scope = useScope();
  return useQuery({
    enabled: clubId !== null,
    queryKey: ["club", clubId, "groups", ...scope],
    queryFn: async () => {
      // Clubs have tens of groups: read all pages for the tree.
      const items: Group[] = [];
      let cursor: string | undefined;
      do {
        const page = data(
          await api.GET("/api/v1/clubs/{clubId}/groups", {
            params: {
              path: { clubId: clubId ?? "" },
              query: { limit: 200, ...(cursor ? { cursor } : {}) },
            },
          }),
        );
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
  });
}

export function useGroup(groupId: string) {
  const { api } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["group", groupId, ...scope],
    queryFn: async () =>
      data(await api.GET("/api/v1/groups/{groupId}", { params: { path: { groupId } } })),
  });
}

export const ROSTER_PAGE_SIZE = 50;

export function useRoster(groupId: string) {
  const { api } = useSession();
  const scope = useScope();
  return useInfiniteQuery({
    queryKey: ["group", groupId, "members", ...scope],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      data(
        await api.GET("/api/v1/groups/{groupId}/members", {
          params: {
            path: { groupId },
            query: { limit: ROSTER_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? null,
  });
}

export function usePerson(personId: string, clubId: string | null) {
  const { api } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["person", personId, clubId, ...scope],
    queryFn: async () =>
      data(
        await api.GET("/api/v1/people/{personId}", {
          params: { path: { personId }, query: clubId ? { clubId } : {} },
        }),
      ),
  });
}

export function useSessions() {
  const { api, personId } = useSession();
  return useQuery({
    queryKey: ["me", personId, "sessions"],
    queryFn: async () => data(await api.GET("/api/v1/me/sessions")),
    // Never shown from an old cache: it is a security screen.
    staleTime: 0,
  });
}

// Protected identity (P1.12): turning the global flag on or off. Afterwards
// every cached view may show the person differently: everything is
// refetched (the persisted cache of the affected clubs included).
export function useSetProtection() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { personId: string; protected: boolean }) =>
      data(
        await api.PUT("/api/v1/people/{personId}/protection", {
          params: { path: { personId: input.personId }, query: {} },
          body: { protected: input.protected },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries(),
  });
}

// Calendar subscriptions (P1.11): the list (never secrets) and creating one
// for my schedule and all my children; the app opens its webcal URL once.
export function useCalendarFeeds() {
  const { api, personId } = useSession();
  return useQuery({
    queryKey: ["me", personId, "calendar-feeds"],
    queryFn: async () => data(await api.GET("/api/v1/me/calendar-feeds")),
    enabled: personId !== null,
  });
}

export function useCreateCalendarFeed() {
  const { api, personId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => data(await api.POST("/api/v1/me/calendar-feeds", { body: {} })),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["me", personId, "calendar-feeds"] }),
  });
}

export function useRevokeSession() {
  const { api, personId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await api.DELETE("/api/v1/me/sessions/{sessionId}", {
        params: { path: { sessionId } },
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["me", personId, "sessions"] }),
  });
}

export function useUpdatePreferences() {
  const { api, personId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<Preferences>) =>
      data(await api.PATCH("/api/v1/me/preferences", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me", personId] }),
  });
}

/** Supported app versions, flags and server capabilities (ADR 0029). */
export function useClientInfo() {
  const { api } = useSession();
  return useQuery({
    queryKey: ["meta", "client"],
    queryFn: async () => data(await api.GET("/api/v1/meta/client")),
    staleTime: 3 * 60 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useSource() {
  const { api } = useSession();
  return useQuery({
    queryKey: ["meta", "source"],
    queryFn: async () => data(await api.GET("/api/v1/meta/source")),
    staleTime: 24 * 60 * 60 * 1000,
  });
}

// Activities (P1.4).
export type ScheduleEntry = Schemas["ScheduleEntry"];
export type SchedulePage = Schemas["SchedulePage"];
export type ActivityDetail = Schemas["ActivityDetail"];

/** How far ahead "My schedule" reads (one request; the API pages at 500). */
export const SCHEDULE_DAYS = 28;

/**
 * My schedule (and my wards'), across clubs. One key per viewer, not per
 * day, so the persisted cache still opens the screen offline tomorrow (the
 * screen leaves out what has ended).
 */
export function useSchedule() {
  const { api, personId } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["schedule", ...scope],
    queryFn: async () => {
      const now = Date.now();
      return data(
        await api.GET("/api/v1/me/schedule", {
          params: {
            query: {
              from: new Date(now - 2 * 3_600_000).toISOString(),
              to: new Date(now + SCHEDULE_DAYS * 86_400_000).toISOString(),
              limit: 500,
            },
          },
        }),
      );
    },
    enabled: personId !== null,
  });
}

type Scope = readonly [string | null, string];

/** Query options shared by the screens and the prefetch (state/prefetch.ts): one cache entry each. */
export const activityQuery = (api: ApiClient, scope: Scope, activityId: string) => ({
  queryKey: ["activity", activityId, ...scope] as const,
  queryFn: async () =>
    data(
      await api.GET("/api/v1/activities/{activityId}", {
        params: { path: { activityId } },
      }),
    ),
});

export const responseSummaryQuery = (api: ApiClient, scope: Scope, activityId: string) => ({
  queryKey: ["responses", activityId, ...scope] as const,
  queryFn: async () =>
    data(
      await api.GET("/api/v1/activities/{activityId}/responses/summary", {
        params: { path: { activityId } },
      }),
    ),
});

export const eventQuery = (api: ApiClient, scope: Scope, eventId: string) => ({
  queryKey: ["event", eventId, ...scope] as const,
  queryFn: async () =>
    data(await api.GET("/api/v1/events/{eventId}", { params: { path: { eventId } } })),
});

export function useActivity(activityId: string) {
  const { api } = useSession();
  return useQuery(activityQuery(api, useScope(), activityId));
}

// Responses and attendance (P1.5); writes go through the outbox (outbox.ts).
export type ResponseSummary = Schemas["ResponseSummary"];
export type Attendance = Schemas["Attendance"];

export function useResponseSummary(activityId: string) {
  const { api } = useSession();
  return useQuery(responseSummaryQuery(api, useScope(), activityId));
}

/** The leaders' list of answers (P1.6b: leaders answer for participants); first 200. */
export function useResponseList(activityId: string, enabled: boolean) {
  const { api } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["responses", activityId, "list", ...scope],
    enabled,
    queryFn: async () =>
      data(
        await api.GET("/api/v1/activities/{activityId}/responses", {
          params: { path: { activityId }, query: { limit: 200 } },
        }),
      ),
  });
}

/** The attendance sheet (leaders); kept in the cache for taking attendance offline. */
export function useAttendance(activityId: string, enabled = true) {
  const { api } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["attendance", activityId, ...scope],
    queryFn: async () =>
      data(
        await api.GET("/api/v1/activities/{activityId}/attendance", {
          params: { path: { activityId } },
        }),
      ),
    enabled,
  });
}

// Events with sign-up (P1.6). Sign-up needs a connection (the server decides
// places): these are plain mutations, never queued in the outbox.
export type EventDetail = Schemas["EventDetail"];
export type MyEvents = Schemas["MyEvents"];
export type EventQuestion = Schemas["EventQuestion"];

export function useMyEvents() {
  const { api, personId } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["events", ...scope],
    queryFn: async () =>
      data(await api.GET("/api/v1/me/events", { params: { query: { limit: 50 } } })),
    enabled: personId !== null,
  });
}

export function useEvent(eventId: string) {
  const { api } = useSession();
  return useQuery(eventQuery(api, useScope(), eventId));
}

type RegistrationChange =
  | { action: "register"; personId: string; answers: Record<string, unknown> }
  | { action: "cancel" | "accept" | "decline"; personId: string };

/** Sign up, cancel, or answer an offer; the answer is the updated event. */
export function useRegistration(eventId: string) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: async (change: RegistrationChange) => {
      const path = { eventId, personId: change.personId };
      switch (change.action) {
        case "register":
          return data(
            await api.PUT("/api/v1/events/{eventId}/registrations/{personId}", {
              params: { path },
              body: { answers: change.answers },
            }),
          );
        case "cancel":
          return data(
            await api.DELETE("/api/v1/events/{eventId}/registrations/{personId}", {
              params: { path },
            }),
          );
        case "accept":
          return data(
            await api.POST("/api/v1/events/{eventId}/registrations/{personId}/accept", {
              params: { path },
            }),
          );
        case "decline":
          return data(
            await api.POST("/api/v1/events/{eventId}/registrations/{personId}/decline", {
              params: { path },
            }),
          );
      }
    },
    onSuccess: (event) => {
      queryClient.setQueryData(["event", eventId, ...scope], event);
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      void queryClient.invalidateQueries({ queryKey: ["schedule"] });
    },
  });
}

// Notifications (P1.7): always the logged-in person's, never a ward's.
export type NotificationItem = Schemas["Notification"];
export type NotificationSettings = Schemas["NotificationSettingsResponse"];
export type NotificationSettingsUpdate = Schemas["UpdateNotificationSettings"];

export function useNotifications() {
  const { api, personId } = useSession();
  return useInfiniteQuery({
    queryKey: ["me", personId, "notifications"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      data(
        await api.GET("/api/v1/me/notifications", {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? null,
    enabled: personId !== null,
  });
}

export function useUnreadCount(enabled: boolean) {
  const { api, personId } = useSession();
  return useQuery({
    queryKey: ["me", personId, "notifications", "unread"],
    queryFn: async () => data(await api.GET("/api/v1/me/notifications/unread-count")).count,
    enabled: enabled && personId !== null,
    refetchOnWindowFocus: true,
  });
}

export function useMarkNotificationsRead() {
  const { api, personId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { ids: string[] } | { before: string }) =>
      data(await api.POST("/api/v1/me/notifications/read", { body })),
    onSuccess: (unread) => {
      queryClient.setQueryData(["me", personId, "notifications", "unread"], unread.count);
      void queryClient.invalidateQueries({
        queryKey: ["me", personId, "notifications"],
        exact: true,
      });
    },
  });
}

export function useNotificationSettings() {
  const { api, personId } = useSession();
  return useQuery({
    queryKey: ["me", personId, "notification-settings"],
    queryFn: async () => data(await api.GET("/api/v1/me/notification-settings")),
    enabled: personId !== null,
  });
}

export function useUpdateNotificationSettings() {
  const { api, personId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: NotificationSettingsUpdate) =>
      data(await api.PUT("/api/v1/me/notification-settings", { body })),
    onSuccess: (settings) =>
      queryClient.setQueryData(["me", personId, "notification-settings"], settings),
  });
}

// Privacy (P1.8a). The person's own data (never on behalf of a ward: the
// guardian's overview covers the wards). Cache first: the screen shows the
// cached consents at once; a change is shown at once and rolled back if the
// server refuses it.
export type MyConsents = Schemas["MyConsents"];
export type PrivacyPolicy = Schemas["PrivacyPolicy"];

export const myConsentsQuery = (api: ApiClient, personId: string | null) => ({
  queryKey: ["me", personId, "consents"] as const,
  queryFn: async () => data(await api.GET("/api/v1/me/consents")),
});

export function useMyConsents() {
  const { api, personId } = useSession();
  return useQuery({ ...myConsentsQuery(api, personId), enabled: personId !== null });
}

export const privacyPolicyQuery = (api: ApiClient, personId: string | null, clubId: string) => ({
  queryKey: ["me", personId, "privacy-policy", clubId] as const,
  queryFn: async () =>
    data(
      await api.GET("/api/v1/clubs/{clubId}/privacy-policy", {
        params: { path: { clubId } },
      }),
    ),
});

export function usePrivacyPolicy(clubId: string) {
  const { api, personId } = useSession();
  return useQuery({ ...privacyPolicyQuery(api, personId, clubId), enabled: personId !== null });
}

interface ConsentChange {
  clubId: string;
  personId: string;
  purpose: Schemas["ConsentStatus"]["purpose"];
  /** The text version to give; null withdraws. */
  give: string | null;
}

export function useChangeConsent() {
  const { api, personId } = useSession();
  const queryClient = useQueryClient();
  const key = ["me", personId, "consents"];
  return useMutation({
    mutationFn: async (change: ConsentChange) => {
      const params = {
        path: { personId: change.personId, purpose: change.purpose },
        query: { clubId: change.clubId },
      };
      if (change.give) {
        await api.PUT("/api/v1/people/{personId}/consents/{purpose}", {
          params,
          body: { textVersion: change.give },
        });
      } else {
        await api.DELETE("/api/v1/people/{personId}/consents/{purpose}", { params });
      }
    },
    // Shown at once (optimistic), rolled back when the server refuses.
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<MyConsents>(key);
      if (previous) {
        queryClient.setQueryData<MyConsents>(key, {
          clubs: previous.clubs.map((club) =>
            club.clubId !== change.clubId
              ? club
              : {
                  ...club,
                  people: club.people.map((p) =>
                    p.person.id !== change.personId
                      ? p
                      : {
                          ...p,
                          purposes: p.purposes.map((s) =>
                            s.purpose !== change.purpose
                              ? s
                              : {
                                  ...s,
                                  mayGive: change.give === null,
                                  mayWithdraw: change.give !== null,
                                  // The server's answer (onSettled) fills in who gave it.
                                  consent: change.give
                                    ? ({
                                        textVersion: change.give,
                                        current: true,
                                        source: "self",
                                        givenAt: new Date().toISOString(),
                                        givenBy: null,
                                      } as unknown as Schemas["OpenConsent"])
                                    : null,
                                },
                          ),
                        },
                  ),
                },
          ),
        });
      }
      return { previous };
    },
    onError: (_error, _change, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
}

// Account deletion (P1.8b): the preview is cached like everything else but
// always refreshed before confirming; scheduling and cancelling update /me
// (the banner) and the preview.
export type AccountDeletionPreview = Schemas["AccountDeletionPreview"];

export const deletionPreviewQuery = (api: ApiClient, personId: string | null) => ({
  queryKey: ["me", personId, "account-deletion"] as const,
  queryFn: async () => data(await api.GET("/api/v1/me/account/deletion")),
});

export function useDeletionPreview() {
  const { api, personId } = useSession();
  return useQuery({ ...deletionPreviewQuery(api, personId), enabled: personId !== null });
}

export function useAccountDeletion() {
  const { api, personId } = useSession();
  const queryClient = useQueryClient();
  const settle = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["me", personId, "account-deletion"] }),
      queryClient.invalidateQueries({ queryKey: ["me", personId], exact: true }),
    ]);
  const schedule = useMutation({
    mutationFn: async (eraseWardIds: string[]) =>
      data(await api.POST("/api/v1/me/account/deletion", { body: { eraseWardIds } })),
    onSettled: settle,
  });
  const cancel = useMutation({
    mutationFn: async () => {
      data(await api.DELETE("/api/v1/me/account/deletion"));
    },
    onSettled: settle,
  });
  return { schedule, cancel };
}
