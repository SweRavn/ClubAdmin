// SPDX-License-Identifier: AGPL-3.0-only
// Data hooks over the typed client. Keys include the ward when viewing as
// one, so a guardian's and a ward's data never mix in the cache. Responses
// are used as the generated types describe them, never parsed strictly:
// unknown fields and enum values from a newer server are tolerated (ADR 0029).

import type { components } from "@clubadmin/api-client";
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
function useScope() {
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

export function useActivity(activityId: string) {
  const { api } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["activity", activityId, ...scope],
    queryFn: async () =>
      data(
        await api.GET("/api/v1/activities/{activityId}", {
          params: { path: { activityId } },
        }),
      ),
  });
}

// Responses and attendance (P1.5); writes go through the outbox (outbox.ts).
export type ResponseSummary = Schemas["ResponseSummary"];
export type Attendance = Schemas["Attendance"];

export function useResponseSummary(activityId: string) {
  const { api } = useSession();
  const scope = useScope();
  return useQuery({
    queryKey: ["responses", activityId, ...scope],
    queryFn: async () =>
      data(
        await api.GET("/api/v1/activities/{activityId}/responses/summary", {
          params: { path: { activityId } },
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
