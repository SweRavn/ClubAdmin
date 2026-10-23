// SPDX-License-Identifier: AGPL-3.0-only
// Form actions of the joining pages (P1.1): each turns a posted form into one
// API call and a redirect (success or `?error=<detail>` back to the form), so
// the pages work without client JavaScript. The route handler
// (app/actions/[action]/route.ts) checks the session and the CSRF token.

import {
  ACTIVITY_KINDS,
  addChildInput,
  addMemberFormInput,
  GUARDIANSHIP_KINDS,
  GUARDIANSHIP_RIGHTS,
  type GuardianshipRight,
  HOME_AWAY,
  isLinkedGuardianshipKind,
  isUuid,
  linkedPersonInput,
  MEMBER_EXPORT_COLUMNS,
  type MemberExportColumn,
  MEMBERSHIP_TYPES,
  RegisterFilterSchema,
  zonedTime,
} from "@clubadmin/shared";

import { safeReturnTo } from "./return-to.ts";

export interface ApiCall {
  path: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

export interface FormAction {
  /** The API call, or null if the form is not valid (then: back with ?error=invalid_input). */
  call(form: FormData): ApiCall | null;
  /** Where to go on success; `result` is the API's JSON body (or null). */
  done(form: FormData, result: unknown): string;
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const id = (form: FormData, name: string): string | null => {
  const value = text(form, name);
  return isUuid(value) ? value : null;
};
const optional = (value: string) => (value === "" ? undefined : value);
const back = (form: FormData, fallback = "/") => safeReturnTo(text(form, "back"), fallback);
const withParam = (path: string, key: string, value: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

/** The register filter carried by the export form (hidden fields, as in the list's URL). */
function exportFilter(form: FormData): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(RegisterFilterSchema.shape)) {
    const value = text(form, `filter.${key}`);
    if (!value) continue;
    raw[key] =
      key === "status" || key === "type"
        ? value.split(",")
        : key === "bornFrom" || key === "bornTo"
          ? Number(value)
          : value;
  }
  const parsed = RegisterFilterSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** Checked rights of a relative or contact person (checkboxes named "right"). */
const rightsOf = (form: FormData): GuardianshipRight[] =>
  form
    .getAll("right")
    .filter((r): r is GuardianshipRight => (GUARDIANSHIP_RIGHTS as readonly unknown[]).includes(r));
const kindOf = (form: FormData) => {
  const kind = text(form, "kind");
  return (GUARDIANSHIP_KINDS as readonly string[]).includes(kind) ? kind : null;
};
const isLinked = isLinkedGuardianshipKind;
/** A person without login (name, phone) from the form's person fields. */
const newPerson = (form: FormData) => linkedPersonInput((name) => text(form, name));

/** Families (P1.3). */
const FAMILY_ACTIONS: Record<string, FormAction> = {
  "add-child": {
    call: (form) => {
      const country = text(form, "pinCountry");
      const pin = text(form, "personalIdentityNumber");
      return {
        path: "/api/v1/me/wards",
        method: "POST",
        body: addChildInput((name) => text(form, name), {
          kind: text(form, "kind") === "legal_guardian" ? "legal_guardian" : "parent",
          ...(pin ? { personalIdentityNumber: { country: country || "SE", value: pin } } : {}),
        }),
      };
    },
    done: (form) => withParam(back(form, "/me/family"), "added", "1"),
  },
  "invite-guardian": {
    call: (form) => {
      const wardId = id(form, "wardId");
      const kind = kindOf(form);
      if (!wardId || !kind) return null;
      return {
        path:
          wardId === text(form, "selfId")
            ? "/api/v1/me/trusted-people"
            : `/api/v1/me/wards/${wardId}/guardian-invitations`,
        method: "POST",
        body: {
          email: text(form, "email"),
          kind,
          ...(isLinked(kind) ? { rights: rightsOf(form) } : {}),
        },
      };
    },
    done: (form) => withParam(back(form, "/me/family"), "invited", "1"),
  },
  "add-linked-person": {
    call: (form) => {
      const wardId = id(form, "wardId");
      const kind = kindOf(form);
      if (!wardId || !kind || !isLinked(kind)) return null;
      return {
        path:
          wardId === text(form, "selfId")
            ? "/api/v1/me/trusted-people"
            : `/api/v1/me/wards/${wardId}/guardians`,
        method: "POST",
        body: { person: newPerson(form), kind, rights: rightsOf(form) },
      };
    },
    done: (form) => withParam(back(form, "/me/family"), "linked", "1"),
  },
  "resend-guardian-invitation": {
    call: (form) => {
      const invitationId = id(form, "invitationId");
      return invitationId
        ? { path: `/api/v1/guardian-invitations/${invitationId}/resend`, method: "POST" }
        : null;
    },
    done: (form) => withParam(back(form, "/me/family"), "resent", "1"),
  },
  "revoke-guardian-invitation": {
    call: (form) => {
      const invitationId = id(form, "invitationId");
      return invitationId
        ? { path: `/api/v1/guardian-invitations/${invitationId}/revoke`, method: "POST" }
        : null;
    },
    done: (form) => back(form, "/me/family"),
  },
  "update-guardian-rights": {
    call: (form) => {
      const guardianshipId = id(form, "guardianshipId");
      return guardianshipId
        ? {
            path: `/api/v1/guardianships/${guardianshipId}`,
            method: "PATCH",
            body: { rights: rightsOf(form) },
          }
        : null;
    },
    done: (form) => withParam(back(form, "/me/family"), "updated", "1"),
  },
  "end-guardianship": {
    call: (form) => {
      const guardianshipId = id(form, "guardianshipId");
      if (!guardianshipId || text(form, "confirm") !== "on") return null;
      return { path: `/api/v1/guardianships/${guardianshipId}/end`, method: "POST" };
    },
    done: (form) => withParam(back(form, "/me/family"), "ended", "1"),
  },
  "accept-guardian-invitation": {
    call: (form) => {
      const token = text(form, "token");
      return token
        ? { path: "/api/v1/guardian-invitations/accept", method: "POST", body: { token } }
        : null;
    },
    done: (_form, result) =>
      (result as { suggestProtection?: boolean } | null)?.suggestProtection
        ? "/me/family?accepted=protected"
        : "/me/family?accepted=1",
  },
  "give-own-login": {
    call: (form) => {
      const personId = id(form, "personId");
      return personId
        ? {
            path: `/api/v1/people/${personId}/own-login-invitations`,
            method: "POST",
            body: { email: text(form, "email") },
          }
        : null;
    },
    done: (form) => withParam(back(form, "/me/family"), "ownLogin", "1"),
  },
  "merge-people": {
    call: (form) => {
      const personId = id(form, "personId");
      const duplicateId = id(form, "duplicatePersonId");
      const clubId = id(form, "clubId");
      if (!personId || !duplicateId) return null;
      return {
        path: `/api/v1/people/${personId}/merge${clubId ? `?clubId=${clubId}` : ""}`,
        method: "POST",
        body: { duplicatePersonId: duplicateId },
      };
    },
    done: (form) => withParam(back(form, "/me/family"), "merged", "1"),
  },
  "undo-merge": {
    call: (form) => {
      const mergeId = id(form, "mergeId");
      const clubId = id(form, "clubId");
      return mergeId
        ? {
            path: `/api/v1/people/merges/${mergeId}/undo${clubId ? `?clubId=${clubId}` : ""}`,
            method: "POST",
          }
        : null;
    },
    done: (form) => withParam(back(form, "/me/family"), "undone", "1"),
  },
  "adult-decision": {
    call: (form) => {
      const guardianshipId = id(form, "guardianshipId");
      const decision = text(form, "decision");
      if (!guardianshipId || (decision !== "keep" && decision !== "end")) return null;
      return {
        path: `/api/v1/me/adult-guardians/${guardianshipId}/decision`,
        method: "POST",
        body: { decision },
      };
    },
    done: (form) => withParam(back(form, "/me/family/adult"), "decided", "1"),
  },
  "club-add-guardian": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      const kind = kindOf(form);
      if (!clubId || !personId || !kind) return null;
      const existing = id(form, "guardianPersonId");
      return {
        path: `/api/v1/clubs/${clubId}/members/${personId}/guardians`,
        method: "POST",
        body: {
          guardian: existing ? { personId: existing } : { person: newPerson(form) },
          kind,
          ...(isLinked(kind)
            ? { rights: rightsOf(form), consentNote: optional(text(form, "consentNote")) }
            : {}),
        },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "club-end-guardianship": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const guardianshipId = id(form, "guardianshipId");
      if (!clubId || !guardianshipId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/guardianships/${guardianshipId}/end`,
        method: "POST",
        body: { reason: optional(text(form, "reason")) },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
};

// Activities (P1.4). Times are entered in the club's time zone (hidden field
// timeZone) and sent as UTC instants.
const oneOf = <T extends string>(values: readonly T[], value: string): T | null =>
  (values as readonly string[]).includes(value) ? (value as T) : null;
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
/** The instant of the form's local date and time, null if missing or not a real local time. */
function instant(form: FormData, date: string, time: string): string | null {
  const day = text(form, date);
  const clock = text(form, time);
  const zone = text(form, "timeZone");
  if (!isDate(day) || !isTime(clock) || !zone) return null;
  return zonedTime(day, clock, zone)?.toISOString() ?? null;
}
/** Text fields that are cleared when empty (PATCH) or left out (POST). */
function clearable(
  form: FormData,
  names: readonly string[],
  clear: boolean,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of names) {
    const value = text(form, name);
    if (value) out[name] = value;
    else if (clear) out[name] = null;
  }
  return out;
}
/** A club location, or a free-text place, or neither. */
const placeOf = (form: FormData, clear: boolean) => {
  const locationId = id(form, "locationId");
  const locationText = text(form, "locationText");
  if (locationId) return { locationId, ...(clear ? { locationText: null } : {}) };
  if (locationText) return { locationText, ...(clear ? { locationId: null } : {}) };
  return clear ? { locationId: null, locationText: null } : {};
};
/** Weekly slots from the rows weekday.N, startTime.N, duration.N (empty rows are skipped). */
function slotsOf(form: FormData) {
  const slots: { weekday: number; startTime: string; durationMinutes: number }[] = [];
  for (let n = 0; n < 7; n++) {
    const weekday = Number(text(form, `weekday.${n}`));
    const startTime = text(form, `startTime.${n}`);
    const duration = Number(text(form, `duration.${n}`));
    if (!weekday || !startTime) continue;
    if (!isTime(startTime) || !Number.isInteger(duration)) return null;
    slots.push({ weekday, startTime, durationMinutes: duration });
  }
  return slots;
}
const datesOf = (value: string) => value.split(/[\s,;]+/).filter(isDate);
/** The series fields of the create, change and split forms. */
function seriesFields(form: FormData, clear: boolean) {
  const slots = slotsOf(form);
  if (slots === null) return null;
  const title = text(form, "title");
  return {
    ...(title ? { title } : {}),
    ...clearable(form, ["notes", "leaderNotes"], clear),
    ...placeOf(form, clear),
    ...(slots.length > 0 ? { slots } : {}),
    ...(isDate(text(form, "endsOn")) ? { endsOn: text(form, "endsOn") } : {}),
    skipDates: datesOf(text(form, "skipDates")),
    skipPublicHolidays: text(form, "skipPublicHolidays") === "on",
  };
}
/** The activity fields of the create and edit forms. */
function activityFields(form: FormData, clear: boolean) {
  const startsAt = instant(form, "date", "startTime");
  const endsAt = instant(form, "date", "endTime");
  if (!startsAt || !endsAt) return null;
  const meetAt = text(form, "meetTime") ? instant(form, "date", "meetTime") : null;
  const homeAway = oneOf(HOME_AWAY, text(form, "homeAway"));
  return {
    title: text(form, "title"),
    startsAt,
    endsAt,
    ...(meetAt ? { meetAt } : clear ? { meetAt: null } : {}),
    ...(homeAway ? { homeAway } : clear ? { homeAway: null } : {}),
    ...clearable(form, ["notes", "leaderNotes", "meetPlace", "opponent", "competition"], clear),
    ...placeOf(form, clear),
  };
}
const resultId = (result: unknown): string | null => {
  const value = (result as { id?: unknown } | null)?.id;
  return typeof value === "string" && isUuid(value) ? value : null;
};
const seriesIdOf = (result: unknown): string | null =>
  resultId((result as { series?: unknown } | null)?.series ?? null);

const ACTIVITY_ACTIONS: Record<string, FormAction> = {
  "create-activity": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const kind = oneOf(ACTIVITY_KINDS, text(form, "kind"));
      const fields = activityFields(form, false);
      if (!groupId || !kind || !fields) return null;
      const groupIds = form
        .getAll("otherGroupId")
        .filter((g): g is string => typeof g === "string" && isUuid(g) && g !== groupId);
      return {
        path: `/api/v1/groups/${groupId}/activities`,
        method: "POST",
        body: { kind, ...fields, groupIds },
      };
    },
    done: (form, result) => {
      const created = resultId(result);
      return created ? `/activities/${created}?saved=1` : back(form);
    },
  },
  "update-activity": {
    call: (form) => {
      const activityId = id(form, "activityId");
      const kind = oneOf(ACTIVITY_KINDS, text(form, "kind"));
      const fields = activityFields(form, true);
      if (!activityId || !kind || !fields) return null;
      return {
        path: `/api/v1/activities/${activityId}`,
        method: "PATCH",
        body: { kind, ...fields },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "cancel-activity": {
    call: (form) => {
      const activityId = id(form, "activityId");
      if (!activityId) return null;
      const reason = optional(text(form, "reason"));
      return {
        path: `/api/v1/activities/${activityId}/cancel`,
        method: "POST",
        body: reason ? { reason } : {},
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "restore-activity": {
    call: (form) => {
      const activityId = id(form, "activityId");
      return activityId
        ? { path: `/api/v1/activities/${activityId}/restore`, method: "POST" }
        : null;
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "delete-activity": {
    call: (form) => {
      const activityId = id(form, "activityId");
      return activityId ? { path: `/api/v1/activities/${activityId}`, method: "DELETE" } : null;
    },
    done: (form) => {
      const groupId = id(form, "groupId");
      return groupId ? `/groups/${groupId}?deleted=1` : "/schedule";
    },
  },
  "create-series": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const kind = oneOf(ACTIVITY_KINDS, text(form, "kind")) ?? "training";
      const fields = seriesFields(form, false);
      const startsOn = text(form, "startsOn");
      if (!groupId || !fields || !isDate(startsOn) || !fields.slots) return null;
      return {
        path: `/api/v1/groups/${groupId}/activity-series`,
        method: "POST",
        body: { kind, ...fields, startsOn },
      };
    },
    done: (form, result) => {
      const created = seriesIdOf(result);
      return created ? `/activity-series/${created}?saved=1` : back(form);
    },
  },
  "update-series": {
    call: (form) => {
      const seriesId = id(form, "seriesId");
      const fields = seriesFields(form, true);
      if (!seriesId || !fields) return null;
      const from = text(form, "from");
      return {
        path: `/api/v1/activity-series/${seriesId}`,
        method: "PATCH",
        body: { ...fields, ...(isDate(from) ? { from } : {}) },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "split-series": {
    call: (form) => {
      const seriesId = id(form, "seriesId");
      const activityId = id(form, "activityId");
      const fields = seriesFields(form, true);
      if (!seriesId || !activityId || !fields) return null;
      return {
        path: `/api/v1/activity-series/${seriesId}/split`,
        method: "POST",
        body: { ...fields, activityId },
      };
    },
    done: (form, result) => {
      const created = seriesIdOf(result);
      return created ? `/activity-series/${created}?saved=1` : back(form);
    },
  },
  "create-location": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const body = locationFields(form, false);
      return clubId && body
        ? { path: `/api/v1/clubs/${clubId}/locations`, method: "POST", body }
        : null;
    },
    done: (form) => withParam(back(form), "added", "1"),
  },
  "update-location": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const locationId = id(form, "locationId");
      const archive = text(form, "archive");
      if (!clubId || !locationId) return null;
      const path = `/api/v1/clubs/${clubId}/locations/${locationId}`;
      if (archive === "archive" || archive === "restore") {
        return { path, method: "PATCH", body: { archived: archive === "archive" } };
      }
      const body = locationFields(form, true);
      return body ? { path, method: "PATCH", body } : null;
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
};

/** A location's fields; coordinates as decimal degrees (both or neither). */
function locationFields(form: FormData, clear: boolean) {
  const name = text(form, "name");
  if (!name) return null;
  const lat = text(form, "latitude").replace(",", ".");
  const lon = text(form, "longitude").replace(",", ".");
  const coordinates =
    lat && lon
      ? { latitude: Number(lat), longitude: Number(lon) }
      : clear
        ? { latitude: null, longitude: null }
        : {};
  if (Number.isNaN(coordinates.latitude) || Number.isNaN(coordinates.longitude)) return null;
  return {
    name,
    ...clearable(form, ["street", "postalCode", "city", "directions"], clear),
    ...coordinates,
  };
}

export const FORM_ACTIONS: Record<string, FormAction> = {
  ...FAMILY_ACTIONS,
  ...ACTIVITY_ACTIONS,
  "complete-profile": {
    call: (form) => ({
      path: "/api/v1/me/profile",
      method: "PUT",
      body: { birthDate: text(form, "birthDate") },
    }),
    done: (form) => back(form),
  },
  "request-join": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personIds = form
        .getAll("personId")
        .filter((v): v is string => typeof v === "string" && isUuid(v));
      if (!clubId || personIds.length === 0) return null;
      return {
        path: `/api/v1/clubs/${clubId}/join-requests`,
        method: "POST",
        body: { personIds, message: optional(text(form, "message")) },
      };
    },
    done: (_form, result) => {
      const items = (result as { items?: { result: string }[] } | null)?.items ?? [];
      return items.every((i) => i.result === "member") ? "/?joined=1" : "/?requested=1";
    },
  },
  "withdraw-join-request": {
    call: (form) => {
      const requestId = id(form, "joinRequestId");
      return requestId
        ? { path: `/api/v1/me/join-requests/${requestId}/withdraw`, method: "POST" }
        : null;
    },
    done: (form) => back(form),
  },
  "decide-join-request": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const requestId = id(form, "joinRequestId");
      const decision = text(form, "decision");
      if (!clubId || !requestId || (decision !== "approve" && decision !== "reject")) return null;
      return {
        path: `/api/v1/clubs/${clubId}/join-requests/${requestId}/decision`,
        method: "POST",
        body: { decision, message: optional(text(form, "message")) },
      };
    },
    done: (form) => withParam(back(form), "decided", text(form, "decision")),
  },
  "accept-invitation": {
    call: (form) => {
      const token = text(form, "token");
      const code = text(form, "code");
      if (!token && !code) return null;
      return {
        path: "/api/v1/invitations/accept",
        method: "POST",
        body: token ? { token } : { code },
      };
    },
    done: (_form, result) => {
      const clubId = (result as { clubId?: string } | null)?.clubId;
      return clubId && isUuid(clubId) ? `/clubs/${clubId}?welcome=1` : "/";
    },
  },
  "revoke-invitation": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const invitationId = id(form, "invitationId");
      return clubId && invitationId
        ? { path: `/api/v1/clubs/${clubId}/invitations/${invitationId}/revoke`, method: "POST" }
        : null;
    },
    done: (form) => back(form),
  },
  "create-club": {
    call: (form) => ({
      path: "/api/v1/clubs",
      method: "POST",
      body: {
        name: text(form, "name"),
        shortName: optional(text(form, "shortName")),
        slug: text(form, "slug"),
        country: text(form, "country"),
        joinPolicy: optional(text(form, "joinPolicy")),
      },
    }),
    done: (_form, result) => {
      const r = result as { outcome?: string; club?: { id: string } } | null;
      return r?.outcome === "created" && r.club && isUuid(r.club.id)
        ? `/clubs/${r.club.id}?created=1`
        : "/?creationRequested=1";
    },
  },
  "appoint-manager": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      return clubId && personId
        ? { path: `/api/v1/clubs/${clubId}/managers`, method: "POST", body: { personId } }
        : null;
    },
    done: (form) => back(form),
  },
  "remove-manager": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      return clubId && personId
        ? { path: `/api/v1/clubs/${clubId}/managers/${personId}`, method: "DELETE" }
        : null;
    },
    done: (form) => back(form),
  },
  "propose-handover": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const toPersonId = id(form, "personId");
      return clubId && toPersonId
        ? {
            path: `/api/v1/clubs/${clubId}/manager-handovers`,
            method: "POST",
            body: { toPersonId },
          }
        : null;
    },
    done: (form) => back(form),
  },
  // Adding and importing members (P1.3b).
  "add-member": {
    call: (form) => {
      const clubId = id(form, "clubId");
      if (!clubId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/members`,
        method: "POST",
        body: addMemberFormInput(
          (name) => text(form, name),
          (name) => form.getAll(name).filter((v): v is string => typeof v === "string" && v !== ""),
        ),
      };
    },
    done: (form) => `/clubs/${text(form, "clubId")}/members?added=1`,
  },
  "update-import-mapping": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const importId = id(form, "importId");
      if (!clubId || !importId) return null;
      const columnMap: Record<string, string> = {};
      for (const [key, value] of form.entries()) {
        const column = /^column\.([0-9]{1,3})$/.exec(key);
        if (column && typeof value === "string" && value !== "") columnMap[column[1]!] = value;
      }
      return {
        path: `/api/v1/clubs/${clubId}/member-imports/${importId}/mapping`,
        method: "PUT",
        body: {
          columnMap,
          options: {
            membershipType: text(form, "membershipType") || "active",
            startDate: text(form, "startDate") || null,
            memberNumbers: text(form, "memberNumbers") === "keep" ? "keep" : "assign",
            sendInvitations: text(form, "sendInvitations") === "on",
            consentNote: text(form, "consentNote") || null,
          },
        },
      };
    },
    done: (form) => back(form),
  },
  "update-import-row": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const importId = id(form, "importId");
      const rowNumber = text(form, "rowNumber");
      const action = text(form, "rowAction");
      if (!clubId || !importId || !/^[0-9]{1,6}$/.test(rowNumber)) return null;
      if (!["skip", "unskip", "same_person", "different_person"].includes(action)) return null;
      return {
        path: `/api/v1/clubs/${clubId}/member-imports/${importId}/rows/${rowNumber}`,
        method: "PATCH",
        body: { action },
      };
    },
    done: (form) => back(form),
  },
  "confirm-import": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const importId = id(form, "importId");
      if (!clubId || !importId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/member-imports/${importId}/confirm`,
        method: "POST",
      };
    },
    done: (form) => back(form),
  },
  "cancel-import": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const importId = id(form, "importId");
      if (!clubId || !importId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/member-imports/${importId}/cancel`,
        method: "POST",
      };
    },
    done: (form) => `/clubs/${text(form, "clubId")}/members/import`,
  },
  // Member register (P1.2).
  "create-member-export": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const columns = form
        .getAll("column")
        .filter((c): c is MemberExportColumn =>
          (MEMBER_EXPORT_COLUMNS as readonly unknown[]).includes(c),
        );
      if (!clubId || columns.length === 0) return null;
      return {
        path: `/api/v1/clubs/${clubId}/member-exports`,
        method: "POST",
        body: {
          filter: exportFilter(form),
          columns,
          includeProtected: text(form, "includeProtected") === "on",
        },
      };
    },
    done: (form) => withParam(back(form), "requested", "1"),
  },
  "update-membership": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      const change = text(form, "change");
      if (!clubId || !personId) return null;
      const path = `/api/v1/clubs/${clubId}/members/${personId}/membership`;
      if (change === "pause") return { path, method: "PATCH", body: { status: "paused" } };
      if (change === "resume") return { path, method: "PATCH", body: { status: "active" } };
      if (change === "end") {
        const endedOn = optional(text(form, "endedOn"));
        return { path, method: "PATCH", body: { status: "left", endedOn } };
      }
      const type = text(form, "membershipType");
      if (change === "type" && (MEMBERSHIP_TYPES as readonly string[]).includes(type)) {
        return { path, method: "PATCH", body: { membershipType: type } };
      }
      return null;
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "respond-handover": {
    call: (form) => {
      const handoverId = id(form, "handoverId");
      const response = text(form, "response");
      if (!handoverId || !["accept", "decline", "cancel"].includes(response)) return null;
      return { path: `/api/v1/manager-handovers/${handoverId}/${response}`, method: "POST" };
    },
    done: (form) => back(form),
  },
};
