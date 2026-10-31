// SPDX-License-Identifier: AGPL-3.0-only
// Form actions of the joining pages (P1.1): each turns a posted form into one
// API call and a redirect (success or `?error=<detail>` back to the form), so
// the pages work without client JavaScript. The route handler
// (app/actions/[action]/route.ts) checks the session and the CSRF token.

import {
  ACTIVITY_KINDS,
  addChildInput,
  addMemberFormInput,
  ADMISSION_MODES,
  ATTENDANCE_ROLES,
  ATTENDANCE_STATUSES,
  CLUB_PHONE_NUMBERS_MAX,
  EMAIL_MODES,
  EVENT_ACTIVITIES_MAX,
  EVENT_QUESTIONS_MAX,
  type EventQuestion,
  GENDER_CATEGORIES,
  GROUP_KINDS,
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
  NOTIFICATION_CATEGORIES,
  QUESTION_TYPES,
  RegisterFilterSchema,
  RESPONSE_MODES,
  RESPONSE_STATUSES,
  WAITLIST_MODES,
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
/** Hours before the start (0–336) from the deadline field, null if empty, undefined if invalid. */
function deadlineHours(form: FormData): number | null | undefined {
  const value = text(form, "respondByHours");
  if (value === "") return null;
  const hours = Number(value.replace(",", "."));
  return Number.isFinite(hours) && hours >= 0 && hours <= 336 ? hours : undefined;
}
/** The series fields of the create, change and split forms. */
function seriesFields(form: FormData, clear: boolean) {
  const slots = slotsOf(form);
  if (slots === null) return null;
  const title = text(form, "title");
  const responseMode = oneOf(RESPONSE_MODES, text(form, "responseMode"));
  const hours = deadlineHours(form);
  if (hours === undefined) return null;
  return {
    ...(responseMode ? { responseMode } : {}),
    ...(hours !== null
      ? { respondByMinutes: Math.round(hours * 60) }
      : clear
        ? { respondByMinutes: null }
        : {}),
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
  const responseMode = oneOf(RESPONSE_MODES, text(form, "responseMode"));
  const hours = deadlineHours(form);
  if (hours === undefined) return null;
  const respondBy =
    hours === null ? null : new Date(Date.parse(startsAt) - hours * 3_600_000).toISOString();
  return {
    ...(responseMode ? { responseMode } : {}),
    ...(respondBy ? { respondBy } : clear ? { respondBy: null } : {}),
    title: text(form, "title"),
    startsAt,
    endsAt,
    ...(meetAt ? { meetAt } : clear ? { meetAt: null } : {}),
    ...(homeAway ? { homeAway } : clear ? { homeAway: null } : {}),
    ...clearable(form, ["notes", "leaderNotes", "meetPlace", "opponent", "competition"], clear),
    ...placeOf(form, clear),
  };
}
/** What an "other" activity is (P1.6b); cleared on edit when empty or another kind. */
function kindLabelOf(form: FormData, kind: string, clear: boolean) {
  const label = kind === "other" ? text(form, "kindLabel") : "";
  return label ? { kindLabel: label } : clear ? { kindLabel: null } : {};
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
        body: { kind, ...kindLabelOf(form, kind, false), ...fields, groupIds },
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
        body: { kind, ...kindLabelOf(form, kind, true), ...fields },
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
  // Responses and attendance (P1.5).
  respond: {
    call: (form) => {
      const activityId = id(form, "activityId");
      const personId = id(form, "personId");
      const status = oneOf(RESPONSE_STATUSES, text(form, "status"));
      if (!activityId || !personId || !status) return null;
      // With the note field (the activity page) the note is set, or cleared
      // when emptied; without it (buttons) it stays as it is (P1.6b).
      const note = text(form, "note");
      const withNote = text(form, "noteField") === "1";
      return {
        path: `/api/v1/activities/${activityId}/responses/${personId}`,
        method: "PUT",
        body: { status, ...(withNote ? { note: note || null } : {}) },
      };
    },
    done: (form) => withParam(back(form), "answered", "1"),
  },
  "withdraw-response": {
    call: (form) => {
      const activityId = id(form, "activityId");
      const personId = id(form, "personId");
      return activityId && personId
        ? { path: `/api/v1/activities/${activityId}/responses/${personId}`, method: "DELETE" }
        : null;
    },
    done: (form) => withParam(back(form), "answered", "1"),
  },
  "record-attendance": {
    call: (form) => {
      const activityId = id(form, "activityId");
      if (!activityId) return null;
      const marks: { personId: string; status: string; role: string }[] = [];
      for (const [key, value] of form.entries()) {
        if (!key.startsWith("mark.") || typeof value !== "string") continue;
        const personId = key.slice(5);
        const status = oneOf(ATTENDANCE_STATUSES, value);
        const role = oneOf(ATTENDANCE_ROLES, text(form, `role.${personId}`)) ?? "participant";
        if (isUuid(personId) && status) marks.push({ personId, status, role });
      }
      const guestId = id(form, "guestId");
      if (guestId) marks.push({ personId: guestId, status: "present", role: "participant" });
      if (marks.length === 0) return null;
      const correctedReason = text(form, "correctedReason");
      return {
        path: `/api/v1/activities/${activityId}/attendance`,
        method: "PUT",
        body: { marks, ...(correctedReason ? { correctedReason } : {}) },
      };
    },
    done: (form, result) => {
      const stale = (result as { stale?: unknown[] } | null)?.stale?.length ?? 0;
      const path = withParam(back(form), "saved", "1");
      return stale > 0 ? withParam(path, "stale", String(stale)) : path;
    },
  },
  "set-invitees": {
    call: (form) => {
      const activityId = id(form, "activityId");
      if (!activityId) return null;
      const inviteesOnly = text(form, "inviteesOnly") === "selected";
      const personIds = inviteesOnly
        ? form.getAll("invite").filter((v): v is string => typeof v === "string" && isUuid(v))
        : [];
      return {
        path: `/api/v1/activities/${activityId}/invitees`,
        method: "PUT",
        body: { inviteesOnly, personIds },
      };
    },
    done: (form) => withParam(back(form), "saved", "1"),
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

// Events with sign-up (P1.6). Local times in the club's time zone, as for
// activities; the questions and sessions come as numbered rows (q.0.label,
// q.0.type, ...; a.0.title, ...), empty rows are left out. Only the title
// and the start date are required (P1.6b): a date without a time is the
// start of the day (start) or its end (deadlines); the API fills the end
// and the sign-up deadline.
const EVENT_ROWS = EVENT_QUESTIONS_MAX;
const SESSION_ROWS = EVENT_ACTIVITIES_MAX;

/**
 * An instant from a date field and an optional time field (`missingTime`
 * when empty); undefined when both are empty, null when invalid.
 */
function optionalInstant(
  form: FormData,
  date: string,
  time: string,
  missingTime = "23:59",
): string | null | undefined {
  const day = text(form, date);
  const clock = text(form, time);
  const zone = text(form, "timeZone");
  if (!day && !clock) return undefined;
  if (!isDate(day) || (clock && !isTime(clock)) || !zone) return null;
  return zonedTime(day, clock || missingTime, zone)?.toISOString() ?? null;
}

function questionsOf(form: FormData): EventQuestion[] | null {
  const rows: { order: number; question: EventQuestion }[] = [];
  const used = new Set<string>();
  for (let i = 0; i < EVENT_ROWS; i++) {
    const label = text(form, `q.${i}.label`);
    if (!label || text(form, `q.${i}.remove`) === "on") continue;
    const type = oneOf(QUESTION_TYPES, text(form, `q.${i}.type`));
    if (!type) return null;
    let questionId = text(form, `q.${i}.id`);
    if (!/^[a-z0-9_-]{1,20}$/.test(questionId) || used.has(questionId)) {
      let n = i + 1;
      while (used.has(`q${n}`)) n++;
      questionId = `q${n}`;
    }
    used.add(questionId);
    const choice = type === "choice" || type === "choices";
    const options = text(form, `q.${i}.options`)
      .split(/\r?\n/)
      .map((o) => o.trim())
      .filter((o) => o !== "");
    const order = Number(text(form, `q.${i}.order`) || i + 1);
    rows.push({
      order: Number.isFinite(order) ? order : i + 1,
      question: {
        id: questionId,
        type,
        label,
        required: text(form, `q.${i}.required`) === "on",
        sensitive: text(form, `q.${i}.sensitive`) === "on",
        ...(choice ? { options } : {}),
      },
    });
  }
  return rows.sort((a, b) => a.order - b.order).map((r) => r.question);
}

function eventFields(form: FormData, clear: boolean) {
  const startsAt = optionalInstant(form, "startDate", "startTime", "00:00");
  const endsAt = optionalInstant(form, "endDate", "endTime");
  const registrationClosesAt = optionalInstant(form, "closesDate", "closesTime");
  const registrationOpensAt = optionalInstant(form, "opensDate", "opensTime", "00:00");
  const cancellationClosesAt = optionalInstant(form, "cancelDate", "cancelTime");
  const questions = questionsOf(form);
  if (!startsAt || endsAt === null || registrationClosesAt === null || questions === null) {
    return null;
  }
  if (registrationOpensAt === null || cancellationClosesAt === null) return null;
  const capacityText = text(form, "capacity");
  const capacity = capacityText === "" ? null : Number(capacityText);
  if (capacity !== null && !(Number.isInteger(capacity) && capacity > 0)) return null;
  const waitlistMode = oneOf(WAITLIST_MODES, text(form, "waitlistMode"));
  const hours = Number(text(form, "offerReplyHours") || "24");
  return {
    title: text(form, "title"),
    ...clearable(form, ["description", "priceText"], clear),
    startsAt,
    // Left empty: the API's default on create; unchanged on edit.
    ...(endsAt ? { endsAt } : {}),
    ...placeOf(form, clear),
    ...(registrationClosesAt ? { registrationClosesAt } : {}),
    ...(registrationOpensAt ? { registrationOpensAt } : clear ? { registrationOpensAt: null } : {}),
    ...(cancellationClosesAt
      ? { cancellationClosesAt }
      : clear
        ? { cancellationClosesAt: null }
        : {}),
    ...(capacity !== null ? { capacity } : clear ? { capacity: null } : {}),
    ...(waitlistMode ? { waitlistMode } : {}),
    ...(Number.isInteger(hours) && hours >= 1 && hours <= 168 ? { offerReplyHours: hours } : {}),
    questions,
  };
}

/** Sessions created with a group event (rows a.N; empty rows are left out). */
function sessionsOf(form: FormData) {
  const sessions = [];
  for (let i = 0; i < SESSION_ROWS; i++) {
    const title = text(form, `a.${i}.title`);
    if (!title) continue;
    const kind = oneOf(ACTIVITY_KINDS, text(form, `a.${i}.kind`));
    const startsAt = instant(form, `a.${i}.date`, `a.${i}.startTime`);
    const endsAt = instant(form, `a.${i}.date`, `a.${i}.endTime`);
    if (!kind || !startsAt || !endsAt) return null;
    const kindLabel = kind === "other" ? text(form, `a.${i}.kindLabel`) : "";
    sessions.push({ kind, title, startsAt, endsAt, ...(kindLabel ? { kindLabel } : {}) });
  }
  return sessions;
}

/** Answers from the sign-up form: fields named answer.<questionId>. */
function answersOf(form: FormData): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const key of new Set(form.keys())) {
    if (!key.startsWith("answer.")) continue;
    const questionId = key.slice("answer.".length);
    const type = text(form, `type.${questionId}`);
    const values = form.getAll(key).filter((v): v is string => typeof v === "string");
    const value = (values[0] ?? "").trim();
    if (type === "choices") answers[questionId] = values.filter((v) => v !== "");
    else if (type === "number") answers[questionId] = value === "" ? "" : Number(value);
    else if (type === "yes_no") answers[questionId] = value === "" ? "" : value === "yes";
    else answers[questionId] = value;
  }
  return answers;
}

const registration = (form: FormData, suffix = "") => {
  const eventId = id(form, "eventId");
  const personId = id(form, "personId");
  return eventId && personId
    ? `/api/v1/events/${eventId}/registrations/${personId}${suffix}`
    : null;
};

const EVENT_ACTIONS: Record<string, FormAction> = {
  "create-event": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const fields = eventFields(form, false);
      const activities = sessionsOf(form);
      if (!clubId || !fields || !activities) return null;
      const audience = text(form, "audience") === "club" ? "club" : "groups";
      const groupIds = form
        .getAll("groupId")
        .filter((g): g is string => typeof g === "string" && isUuid(g));
      return {
        path: `/api/v1/clubs/${clubId}/events`,
        method: "POST",
        body: {
          ...fields,
          audience,
          groupIds: audience === "club" ? [] : groupIds,
          activities: audience === "club" ? [] : activities,
          publish: text(form, "publish") === "on",
        },
      };
    },
    done: (form, result) => {
      const created = resultId(result);
      if (!created) return back(form);
      // A draft: the notice says where drafts are found.
      return `/events/${created}?${text(form, "publish") === "on" ? "saved=1" : "drafted=1"}`;
    },
  },
  "update-event": {
    call: (form) => {
      const eventId = id(form, "eventId");
      const fields = eventFields(form, true);
      if (!eventId || !fields) return null;
      return { path: `/api/v1/events/${eventId}`, method: "PATCH", body: fields };
    },
    done: (form) => `/events/${text(form, "eventId")}?updated=1`,
  },
  "publish-event": {
    call: (form) => {
      const eventId = id(form, "eventId");
      return eventId ? { path: `/api/v1/events/${eventId}/publish`, method: "POST" } : null;
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "cancel-event": {
    call: (form) => {
      const eventId = id(form, "eventId");
      if (!eventId) return null;
      return {
        path: `/api/v1/events/${eventId}/cancel`,
        method: "POST",
        body: { reason: optional(text(form, "reason")) },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "delete-event": {
    call: (form) => {
      const eventId = id(form, "eventId");
      return eventId ? { path: `/api/v1/events/${eventId}`, method: "DELETE" } : null;
    },
    done: (form) => `/clubs/${text(form, "clubId")}/events?deleted=1`,
  },
  register: {
    call: (form) => {
      const path = registration(form);
      return path ? { path, method: "PUT", body: { answers: answersOf(form) } } : null;
    },
    done: (form) => withParam(back(form), "saved", "1"),
  },
  "cancel-registration": {
    call: (form) => {
      const path = registration(form);
      return path ? { path, method: "DELETE" } : null;
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "answer-offer": {
    call: (form) => {
      const answer = text(form, "answer");
      if (answer !== "accept" && answer !== "decline") return null;
      const path = registration(form, `/${answer}`);
      return path ? { path, method: "POST" } : null;
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "decide-registration": {
    call: (form) => {
      const decision = text(form, "decision");
      const reason = text(form, "reason");
      if ((decision !== "confirm" && decision !== "remove") || !reason) return null;
      const path = registration(form, `/${decision}`);
      return path ? { path, method: "POST", body: { reason } } : null;
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
};

// Groups (P1.6b): created by club managers and owners (under their groups),
// changed, archived, restored and, while unused, deleted.
const intOrNull = (form: FormData, name: string): number | null | undefined => {
  const value = text(form, name);
  if (value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

function groupFields(form: FormData) {
  const name = text(form, "name");
  const kind = oneOf(GROUP_KINDS, text(form, "kind"));
  if (!name || !kind) return null;
  const numbers = {
    birthYearFrom: intOrNull(form, "birthYearFrom"),
    birthYearTo: intOrNull(form, "birthYearTo"),
    capacity: intOrNull(form, "capacity"),
  };
  if (Object.values(numbers).some((n) => n === undefined)) return null;
  const days = Number(text(form, "offerReplyDays") || "7");
  const admissionMode = oneOf(ADMISSION_MODES, text(form, "admissionMode"));
  return {
    name,
    kind,
    parentGroupId: id(form, "parentGroupId"),
    sport: text(form, "sport") || null,
    level: text(form, "level") || null,
    genderCategory: oneOf(GENDER_CATEGORIES, text(form, "genderCategory")),
    ...numbers,
    ...(admissionMode ? { admissionMode } : {}),
    ...(Number.isInteger(days) && days >= 1 && days <= 60 ? { offerReplyDays: days } : {}),
  };
}

const GROUP_ACTIONS: Record<string, FormAction> = {
  "create-group": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const fields = groupFields(form);
      return clubId && fields
        ? { path: `/api/v1/clubs/${clubId}/groups`, method: "POST", body: fields }
        : null;
    },
    done: (form, result) => {
      const created = resultId(result);
      return created ? `/groups/${created}?saved=1` : back(form);
    },
  },
  "update-group": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const fields = groupFields(form);
      return groupId && fields
        ? { path: `/api/v1/groups/${groupId}`, method: "PATCH", body: fields }
        : null;
    },
    done: (form) => `/groups/${text(form, "groupId")}?updated=1`,
  },
  "archive-group": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const what = text(form, "what");
      if (!groupId || (what !== "archive" && what !== "restore")) return null;
      return { path: `/api/v1/groups/${groupId}/${what}`, method: "POST" };
    },
    done: (form) => `/groups/${text(form, "groupId")}?updated=1`,
  },
  "delete-group": {
    call: (form) => {
      const groupId = id(form, "groupId");
      if (!groupId || text(form, "confirm") !== "on") return null;
      return { path: `/api/v1/groups/${groupId}`, method: "DELETE" };
    },
    done: (form) => `/clubs/${text(form, "clubId")}/groups?deleted=1`,
  },
};

// Club settings (P1.6b, club managers with a second factor): time zone,
// language, contact details; the phone numbers as rows (phone.N.label,
// phone.N.number, phone.N.order; empty rows are left out).
const CLUB_ACTIONS: Record<string, FormAction> = {
  "update-club-settings": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const timeZone = text(form, "timeZone");
      const defaultLocale = text(form, "defaultLocale");
      const address = {
        street: text(form, "street"),
        postalCode: text(form, "postalCode"),
        city: text(form, "city"),
      };
      const anyAddress = Object.values(address).some((v) => v !== "");
      if (!clubId || !timeZone || !defaultLocale) return null;
      return {
        path: `/api/v1/clubs/${clubId}/settings`,
        method: "PATCH",
        body: {
          timeZone,
          defaultLocale,
          email: text(form, "email") || null,
          organizationNumber: text(form, "organizationNumber") || null,
          address: anyAddress ? { ...address, country: text(form, "country") } : null,
        },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "set-club-phone-numbers": {
    call: (form) => {
      const clubId = id(form, "clubId");
      if (!clubId) return null;
      const rows = [];
      for (let i = 0; i < CLUB_PHONE_NUMBERS_MAX; i++) {
        const label = text(form, `phone.${i}.label`);
        const number = text(form, `phone.${i}.number`);
        if (!label && !number) continue;
        const order = Number(text(form, `phone.${i}.order`) || i + 1);
        rows.push({ order: Number.isFinite(order) ? order : i + 1, label, number });
      }
      const numbers = rows
        .sort((a, b) => a.order - b.order)
        .map(({ label, number }) => ({ label, number }));
      return { path: `/api/v1/clubs/${clubId}/phone-numbers`, method: "PUT", body: { numbers } };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
};

const clock = (value: string) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null);

/** Notifications (P1.7): the inbox, settings and phones of the logged-in person. */
const NOTIFICATION_ACTIONS: Record<string, FormAction> = {
  /** Opens a notice (marks it read, then goes where it leads) or marks all read up to one. */
  "read-notifications": {
    call: (form) => {
      const notice = id(form, "id");
      const before = id(form, "before");
      if (notice)
        return { path: "/api/v1/me/notifications/read", method: "POST", body: { ids: [notice] } };
      if (before)
        return { path: "/api/v1/me/notifications/read", method: "POST", body: { before } };
      return null;
    },
    done: (form) => safeReturnTo(text(form, "to"), back(form, "/me/notifications")),
  },
  "save-notification-settings": {
    call: (form) => {
      const categories = text(form, "categories")
        .split(",")
        .filter((c) => (NOTIFICATION_CATEGORIES as readonly string[]).includes(c))
        .map((category) => {
          const email = text(form, `email.${category}`);
          return {
            category,
            email: (EMAIL_MODES as readonly string[]).includes(email) ? email : "always",
            push: form.get(`push.${category}`) === "on",
          };
        });
      let quietHours: { from: string; to: string } | null = null;
      if (form.get("quiet") === "on") {
        const from = clock(text(form, "quietFrom"));
        const to = clock(text(form, "quietTo"));
        if (!from || !to) return null;
        quietHours = { from, to };
      }
      return {
        path: "/api/v1/me/notification-settings",
        method: "PUT",
        body: { categories, quietHours, pushPreview: form.get("pushPreview") === "on" },
      };
    },
    done: (form) => withParam(back(form, "/me/notifications/settings"), "saved", "1"),
  },
  "remove-push-device": {
    call: (form) => {
      const deviceId = id(form, "deviceId");
      return deviceId ? { path: `/api/v1/me/push-devices/${deviceId}`, method: "DELETE" } : null;
    },
    done: (form) => withParam(back(form, "/me/notifications/settings"), "deleted", "1"),
  },
};

export const FORM_ACTIONS: Record<string, FormAction> = {
  ...FAMILY_ACTIONS,
  ...NOTIFICATION_ACTIONS,
  ...CLUB_ACTIONS,
  ...GROUP_ACTIONS,
  ...ACTIVITY_ACTIONS,
  ...EVENT_ACTIONS,
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
