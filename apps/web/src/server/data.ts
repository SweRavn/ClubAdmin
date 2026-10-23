// SPDX-License-Identifier: AGPL-3.0-only
// Server-side data for pages and layouts: the session and API reads, each
// at most once per request (React cache), validated with the shared Zod
// schemas. API problems become the matching page: 401 → login, 404 → the
// not-found page, 403 → the forbidden page.

import {
  ActivityDetailSchema,
  type ActivityPage,
  ActivityPageSchema,
  AdultGuardiansSchema,
  AttendanceSchema,
  ClubDetailSchema,
  ClubDuplicatesSchema,
  ClubGuardiansSchema,
  ClubSearchResultSchema,
  FamilyDuplicatesSchema,
  GroupAttendanceSchema,
  GroupCalendarSchema,
  GroupDetailSchema,
  type GroupList,
  GroupListSchema,
  GroupMemberListSchema,
  GuardianInvitationLookupSchema,
  InvitationListSchema,
  InvitationLookupSchema,
  isUuid,
  JoinRequestListSchema,
  LocationConflictsSchema,
  type LocationList,
  LocationListSchema,
  ManagerListSchema,
  MemberExportListSchema,
  MemberImportListSchema,
  MemberImportRowPageSchema,
  MemberImportSchema,
  MeResponseSchema,
  MyClubCreationRequestsSchema,
  MyClubsSchema,
  MyGroupsSchema,
  MyHandoversSchema,
  MyJoinRequestsSchema,
  MyProfileSchema,
  MyWardsSchema,
  PersonProfileSchema,
  RegisterFacetsSchema,
  RegisterPageSchema,
  ResponseListSchema,
  ResponseSummarySchema,
  SchedulePageSchema,
  type SeriesPreviewInput,
  SeriesPreviewResultSchema,
  SeriesSchema,
  SessionListSchema,
  SourceResponseSchema,
  TrustedPeopleSchema,
  VersionResponseSchema,
  WardGuardiansSchema,
  type z,
} from "@clubadmin/shared";
import { cookies, headers } from "next/headers";
import { forbidden, notFound, redirect } from "next/navigation";
import { cache } from "react";

import { apiFetch } from "./api.ts";
import { SESSION_COOKIE } from "./cookies.ts";
import { freshSession, loadSession, type Session } from "./sessions.ts";

/** Set by the proxy (src/proxy.ts): the requested path and query, for returnTo and the current club. */
export const PATH_HEADER = "x-clubadmin-path";

export const currentPath = cache(
  async (): Promise<string> => (await headers()).get(PATH_HEADER) ?? "/",
);

export const getSession = cache(async (): Promise<Session | null> => {
  const loaded = await loadSession((await cookies()).get(SESSION_COOKIE)?.value);
  return loaded ? freshSession(loaded) : null;
});

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(await currentPath())}`);
  return session;
}

/** An unexpected API answer (5xx, malformed): the error boundary shows it with its request ID. */
export class ApiResponseError extends Error {
  readonly status: number;
  readonly requestId: string | null;

  constructor(status: number, requestId: string | null) {
    super(`API answered ${status}`);
    this.name = "ApiResponseError";
    this.status = status;
    this.requestId = requestId;
  }
}

async function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { nullOn?: readonly number[] } = {},
): Promise<z.infer<S> | null> {
  const session = await requireSession();
  const res = await apiFetch(path, session.record, {
    onBehalfOf: session.record.viewingAs ?? null,
  });
  if (res.ok) return schema.parse(await res.json());
  if (options.nullOn?.includes(res.status)) return null;
  if (res.status === 401) redirect(`/login?returnTo=${encodeURIComponent(await currentPath())}`);
  if (res.status === 404) notFound();
  if (res.status === 403) forbidden();
  throw new ApiResponseError(res.status, res.headers.get("x-request-id"));
}

async function required<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  return (await apiGet(path, schema)) as z.infer<S>;
}

/** Route parameters that are not IDs cannot exist. */
export function requireId(value: string): string {
  if (!isUuid(value)) notFound();
  return value;
}

export const getMe = cache(() => required("/api/v1/me", MeResponseSchema));
export const getMyClubs = cache(() => required("/api/v1/me/clubs", MyClubsSchema));
export const getMyWards = cache(() => required("/api/v1/me/wards", MyWardsSchema));
export const getMyGroups = cache(() => required("/api/v1/me/groups", MyGroupsSchema));
export const getSessions = cache(() => required("/api/v1/me/sessions", SessionListSchema));
export const getClub = cache((clubId: string) =>
  required(`/api/v1/clubs/${requireId(clubId)}`, ClubDetailSchema),
);
export const getGroup = cache((groupId: string) =>
  required(`/api/v1/groups/${requireId(groupId)}`, GroupDetailSchema),
);
/** The first page of a roster, or null if the viewer may see the group but not who is in it. */
export const getGroupMembers = cache((groupId: string, limit: number) =>
  apiGet(`/api/v1/groups/${requireId(groupId)}/members?limit=${limit}`, GroupMemberListSchema, {
    nullOn: [403],
  }),
);
export const getPerson = cache((personId: string, clubId: string | null) =>
  required(
    `/api/v1/people/${requireId(personId)}${clubId && isUuid(clubId) ? `?clubId=${clubId}` : ""}`,
    PersonProfileSchema,
  ),
);

/** All of a club's groups (for the tree; clubs have tens, rarely hundreds). */
export const getClubGroups = cache(async (clubId: string): Promise<GroupList["items"]> => {
  const items: GroupList["items"] = [];
  let cursor: string | null = null;
  do {
    const page: GroupList = await required(
      `/api/v1/clubs/${requireId(clubId)}/groups?limit=200${cursor ? `&cursor=${cursor}` : ""}`,
      GroupListSchema,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
});

// Joining (P1.1).
export const getMyProfile = cache(() => required("/api/v1/me/profile", MyProfileSchema));
export const getMyJoinRequests = cache(() =>
  required("/api/v1/me/join-requests", MyJoinRequestsSchema),
);
export const getMyCreationRequests = cache(() =>
  required("/api/v1/me/club-creation-requests", MyClubCreationRequestsSchema),
);
export const getMyHandovers = cache(() =>
  required("/api/v1/me/manager-handovers", MyHandoversSchema),
);
export const searchClubs = cache((q: string, cursor: string | null) => {
  const query = new URLSearchParams({ limit: "20" });
  if (q) query.set("q", q);
  if (cursor && isUuid(cursor)) query.set("cursor", cursor);
  return required(`/api/v1/clubs?${query.toString()}`, ClubSearchResultSchema);
});
export const getClubJoinRequests = cache((clubId: string) =>
  required(`/api/v1/clubs/${requireId(clubId)}/join-requests?limit=100`, JoinRequestListSchema),
);
export const getClubInvitations = cache((clubId: string) =>
  required(`/api/v1/clubs/${requireId(clubId)}/invitations?limit=100`, InvitationListSchema),
);
export const getClubManagers = cache((clubId: string) =>
  required(`/api/v1/clubs/${requireId(clubId)}/managers`, ManagerListSchema),
);

// Member register (P1.2).
export const getRegister = cache((clubId: string, query: string) =>
  required(`/api/v1/clubs/${requireId(clubId)}/members?${query}`, RegisterPageSchema),
);
export const getRegisterFacets = cache((clubId: string) =>
  required(`/api/v1/clubs/${requireId(clubId)}/members/facets`, RegisterFacetsSchema),
);
/** Recent exports, or null without a second factor (the API answers 403). */
export const getMemberExports = cache((clubId: string) =>
  apiGet(`/api/v1/clubs/${requireId(clubId)}/member-exports?limit=50`, MemberExportListSchema, {
    nullOn: [403],
  }),
);

// Adding and importing members (P1.3b). Imports need a second factor: null
// without one (the API answers 403).
export const getMemberImports = cache((clubId: string) =>
  apiGet(`/api/v1/clubs/${requireId(clubId)}/member-imports?limit=20`, MemberImportListSchema, {
    nullOn: [403],
  }),
);
export const getMemberImport = cache((clubId: string, importId: string) =>
  apiGet(
    `/api/v1/clubs/${requireId(clubId)}/member-imports/${requireId(importId)}`,
    MemberImportSchema,
    { nullOn: [403] },
  ),
);
export const getMemberImportRows = cache((clubId: string, importId: string, query: string) =>
  required(
    `/api/v1/clubs/${requireId(clubId)}/member-imports/${requireId(importId)}/rows?${query}`,
    MemberImportRowPageSchema,
  ),
);
/** Adult members for the guardian picker of "Add member" (the first 200 by name). */
export const getAdultMembers = cache((clubId: string) =>
  required(
    `/api/v1/clubs/${requireId(clubId)}/members?limit=200&bornTo=${new Date().getUTCFullYear() - 18}`,
    RegisterPageSchema,
  ),
);

// Families (P1.3).
export const getWardGuardians = cache((personId: string) =>
  required(`/api/v1/me/wards/${requireId(personId)}/guardians`, WardGuardiansSchema),
);
export const getTrustedPeople = cache(() =>
  required("/api/v1/me/trusted-people", TrustedPeopleSchema),
);
export const getFamilyDuplicates = cache(() =>
  required("/api/v1/me/duplicates", FamilyDuplicatesSchema),
);
export const getAdultGuardians = cache(() =>
  required("/api/v1/me/adult-guardians", AdultGuardiansSchema),
);
/** A member's guardians as the club sees them, or null without club.guardians.manage. */
export const getClubGuardians = cache((clubId: string, personId: string) =>
  apiGet(
    `/api/v1/clubs/${requireId(clubId)}/members/${requireId(personId)}/guardians`,
    ClubGuardiansSchema,
    { nullOn: [403, 404] },
  ),
);
export const getClubDuplicates = cache((clubId: string, cursor: string | null) =>
  required(
    `/api/v1/clubs/${requireId(clubId)}/duplicates?limit=50${
      cursor && /^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(cursor) ? `&cursor=${cursor}` : ""
    }`,
    ClubDuplicatesSchema,
  ),
);

// Activities (P1.4). Calendar ranges are ISO instants; the pages pick them.
const rangeQuery = (from: string, to: string) =>
  `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
/** My schedule (and my wards'), across clubs; `query` adds personId/clubId/cursor. */
export const getSchedule = cache((from: string, to: string, query = "") =>
  required(`/api/v1/me/schedule?${rangeQuery(from, to)}&limit=200${query}`, SchedulePageSchema),
);
export const getGroupCalendar = cache((groupId: string, from: string, to: string) =>
  required(
    `/api/v1/groups/${requireId(groupId)}/activities?${rangeQuery(from, to)}&limit=200`,
    GroupCalendarSchema,
  ),
);
/** The group's calendar, or null if the viewer may see the group but not its activities. */
export const getGroupCalendarIfAllowed = cache((groupId: string, from: string, to: string) =>
  apiGet(
    `/api/v1/groups/${requireId(groupId)}/activities?${rangeQuery(from, to)}&limit=200`,
    GroupCalendarSchema,
    { nullOn: [403] },
  ),
);
export const getClubCalendar = cache(
  (clubId: string, from: string, to: string, filter: string): Promise<ActivityPage> =>
    required(
      `/api/v1/clubs/${requireId(clubId)}/activities?${rangeQuery(from, to)}&limit=500${filter}`,
      ActivityPageSchema,
    ),
);
export const getActivity = cache((activityId: string) =>
  required(`/api/v1/activities/${requireId(activityId)}`, ActivityDetailSchema),
);
export const getSeries = cache((seriesId: string) =>
  required(`/api/v1/activity-series/${requireId(seriesId)}`, SeriesSchema),
);
// Responses and attendance (P1.5).
export const getResponseSummary = cache((activityId: string) =>
  required(`/api/v1/activities/${requireId(activityId)}/responses/summary`, ResponseSummarySchema),
);
/** The leaders' list of answers, or null if the viewer may not see it. */
export const getResponseList = cache((activityId: string) =>
  apiGet(`/api/v1/activities/${requireId(activityId)}/responses?limit=200`, ResponseListSchema, {
    nullOn: [403],
  }),
);
export const getAttendance = cache((activityId: string) =>
  required(`/api/v1/activities/${requireId(activityId)}/attendance`, AttendanceSchema),
);
export const getGroupAttendance = cache(
  (groupId: string, from: string, to: string, cursor: string | null) =>
    required(
      `/api/v1/groups/${requireId(groupId)}/attendance?${rangeQuery(from, to)}&limit=200${
        cursor ? `&cursor=${requireId(cursor)}` : ""
      }`,
      GroupAttendanceSchema,
    ),
);
/** Whether the viewer may see the group's attendance (a summary of one minute; null if not). */
export const getGroupAttendanceIfAllowed = cache((groupId: string, at: string) =>
  apiGet(
    `/api/v1/groups/${requireId(groupId)}/attendance?${rangeQuery(
      at,
      new Date(Date.parse(at) + 60_000).toISOString(),
    )}&limit=1`,
    GroupAttendanceSchema,
    { nullOn: [403] },
  ),
);

/** All of a club's locations (archived ones too with `archived`). */
export const getLocations = cache(
  async (clubId: string, archived = false): Promise<LocationList["items"]> => {
    const items: LocationList["items"] = [];
    let cursor: string | null = null;
    do {
      const page: LocationList = await required(
        `/api/v1/clubs/${requireId(clubId)}/locations?limit=200&archived=${archived}${
          cursor ? `&cursor=${cursor}` : ""
        }`,
        LocationListSchema,
      );
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  },
);
export const getLocationConflicts = cache(
  (clubId: string, locationId: string, from: string, to: string) =>
    required(
      `/api/v1/clubs/${requireId(clubId)}/locations/${requireId(locationId)}/conflicts?${rangeQuery(from, to)}`,
      LocationConflictsSchema,
    ),
);
/** The sessions a series would have (the form's preview), or the problem's detail code. */
export async function previewSeries(
  groupId: string,
  body: SeriesPreviewInput,
): Promise<z.infer<typeof SeriesPreviewResultSchema> | { error: string }> {
  const session = await requireSession();
  const res = await apiFetch(
    `/api/v1/groups/${requireId(groupId)}/activity-series/preview`,
    session.record,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      onBehalfOf: session.record.viewingAs ?? null,
    },
  );
  if (res.ok) return SeriesPreviewResultSchema.parse(await res.json());
  if (res.status === 401) redirect(`/login?returnTo=${encodeURIComponent(await currentPath())}`);
  if (res.status === 403) forbidden();
  const problem = (await res.json().catch(() => null)) as { detail?: string } | null;
  return { error: problem?.detail ?? "invalid_input" };
}

/** What a guardian invitation link is for, without a session; null if it is not usable. */
export const lookupGuardianInvitation = cache(async (token: string) => {
  const res = await apiFetch(
    `/api/v1/guardian-invitations/lookup?token=${encodeURIComponent(token)}`,
    null,
    { forwardedFor: (await headers()).get("x-forwarded-for") },
  );
  if (res.ok) return GuardianInvitationLookupSchema.parse(await res.json());
  if (res.status === 409 || res.status === 400 || res.status === 404) return null;
  throw new ApiResponseError(res.status, res.headers.get("x-request-id"));
});

/** Which club an invitation link is for, without a session; null if it is not usable. */
export const lookupInvitation = cache(async (token: string) => {
  const res = await apiFetch(
    `/api/v1/invitations/lookup?token=${encodeURIComponent(token)}`,
    null,
    {
      forwardedFor: (await headers()).get("x-forwarded-for"),
    },
  );
  if (res.ok) return InvitationLookupSchema.parse(await res.json());
  if (res.status === 409 || res.status === 400 || res.status === 404) return null;
  throw new ApiResponseError(res.status, res.headers.get("x-request-id"));
});

/** Public metadata for the footer; null if the API cannot be reached (the page still renders). */
async function publicMeta<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<z.infer<S> | null> {
  try {
    const res = await apiFetch(path, null);
    return res.ok ? schema.parse(await res.json()) : null;
  } catch {
    return null;
  }
}
export const getSource = cache(() => publicMeta("/api/v1/meta/source", SourceResponseSchema));
export const getVersion = cache(() => publicMeta("/api/v1/meta/version", VersionResponseSchema));
