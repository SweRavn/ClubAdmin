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
  BOARD_SETTING_KEYS,
  CHAT_PUSH_SETTINGS,
  CHAT_REPORT_OUTCOMES,
  CHAT_REPORT_REASONS,
  CLUB_PHONE_NUMBERS_MAX,
  CLUB_SETTINGS,
  type ClubSettingDefinition,
  CONSENT_PURPOSES,
  EMAIL_MODES,
  EVENT_ACTIVITIES_MAX,
  EVENT_QUESTIONS_MAX,
  type EventQuestion,
  GENDER_CATEGORIES,
  GROUP_FUNCTIONS,
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
  WAITLIST_PRIORITY_REASONS,
  WAITLIST_REMOVAL_REASONS,
  zonedTime,
} from "@clubadmin/shared";

import { safeReturnTo } from "./return-to.ts";
import { recurrenceFrom, requestLeadFrom } from "./series-form.ts";

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

/** A role's names from the form (nameSv, nameEn, nameNb); null without any. */
function roleNames(form: FormData): Record<string, string> | null {
  const names: Record<string, string> = {};
  for (const [key, field] of [
    ["sv", "nameSv"],
    ["en", "nameEn"],
    ["nb", "nameNb"],
  ] as const) {
    const value = text(form, field).slice(0, 60);
    if (value) names[key] = value;
  }
  return Object.keys(names).length > 0 ? names : null;
}

/** A club type's or template role's names: all three languages, or null. */
function typeNames(form: FormData): { sv: string; en: string; nb: string } | null {
  const sv = text(form, "nameSv").slice(0, 60);
  const en = text(form, "nameEn").slice(0, 60);
  const nb = text(form, "nameNb").slice(0, 60);
  return sv && en && nb ? { sv, en, nb } : null;
}

/** A club type's one sentence per language (any of them), or undefined. */
function typeDescriptions(form: FormData): Record<string, string> | undefined {
  const texts: Record<string, string> = {};
  for (const [key, field] of [
    ["sv", "descriptionSv"],
    ["en", "descriptionEn"],
    ["nb", "descriptionNb"],
  ] as const) {
    const value = text(form, field).slice(0, 300);
    if (value) texts[key] = value;
  }
  return Object.keys(texts).length > 0 ? texts : undefined;
}

/** The ticked permissions of a role form. */
const permissionsOf = (form: FormData): string[] =>
  form
    .getAll("permission")
    .filter((v): v is string => typeof v === "string" && /^[a-z_.]{3,60}$/.test(v));

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
          // P1.12: created protected; the guardian is asked to protect themselves too.
          ...(text(form, "protectedIdentity") === "1" ? { protectedIdentity: true } : {}),
        }),
      };
    },
    done: (form) => {
      const path = withParam(back(form, "/me/family"), "added", "1");
      return text(form, "protectedIdentity") === "1"
        ? withParam(path, "protectedChild", "1")
        : path;
    },
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
  const get = (name: string) => text(form, name);
  const recurrence = recurrenceFrom(get);
  if (recurrence === null) return null;
  const requestLead = requestLeadFrom(get);
  if (requestLead === undefined) return null;
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
    rule: recurrence.rule,
    ...(recurrence.rule.freq !== "weekly" || recurrence.slots.length > 0
      ? { slots: recurrence.slots }
      : {}),
    ...(recurrence.endsOn === undefined ? {} : { endsOn: recurrence.endsOn }),
    ...(requestLead || clear ? { requestLead } : {}),
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
  const requestLead = requestLeadFrom((name) => text(form, name));
  if (requestLead === undefined) return null;
  const respondBy =
    hours === null ? null : new Date(Date.parse(startsAt) - hours * 3_600_000).toISOString();
  return {
    ...(responseMode ? { responseMode } : {}),
    ...(respondBy ? { respondBy } : clear ? { respondBy: null } : {}),
    ...(requestLead || clear ? { requestLead } : {}),
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
      if (!groupId || !fields || !isDate(startsOn) || fields.endsOn === undefined) return null;
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
  // Removed dates of a series (P1.14): a date or a range, and bringing one back.
  "skip-series-dates": {
    call: (form) => {
      const seriesId = id(form, "seriesId");
      const from = text(form, "from");
      const to = text(form, "to");
      if (!seriesId || !isDate(from) || (to !== "" && !isDate(to))) return null;
      return {
        path: `/api/v1/activity-series/${seriesId}/skipped-dates`,
        method: "POST",
        body: { from, ...(to ? { to } : {}) },
      };
    },
    done: (form) => withParam(back(form), "removed", "1"),
  },
  "restore-series-date": {
    call: (form) => {
      const seriesId = id(form, "seriesId");
      const date = text(form, "date");
      if (!seriesId || !isDate(date)) return null;
      return {
        path: `/api/v1/activity-series/${seriesId}/skipped-dates/${date}`,
        method: "DELETE",
      };
    },
    done: (form) => withParam(back(form), "restored", "1"),
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
    // Checkboxes send nothing when off: the marker says the form had them (P1.10b).
    ...(text(form, "waitlistFields") === "1"
      ? {
          waitlistVisiblePublicly: form.get("waitlistVisiblePublicly") === "on",
          waitlistAutoOffer: form.get("waitlistAutoOffer") === "on",
        }
      : {}),
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
  // Group administration (P1.10a): owners, members, seasons, archiving.
  "add-group-owner": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const personId = id(form, "personId");
      if (!groupId || !personId) return null;
      return { path: `/api/v1/groups/${groupId}/owners`, method: "POST", body: { personId } };
    },
    done: (form) => `/groups/${text(form, "groupId")}/manage?owner=added`,
  },
  "remove-group-owner": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const personId = id(form, "personId");
      if (!groupId || !personId) return null;
      return { path: `/api/v1/groups/${groupId}/owners/${personId}`, method: "DELETE" };
    },
    done: (form) => `/groups/${text(form, "groupId")}/manage?owner=removed`,
  },
  "add-group-member": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const personId = id(form, "personId");
      const fn = text(form, "function");
      if (!groupId || !personId || !(GROUP_FUNCTIONS as readonly string[]).includes(fn))
        return null;
      const roleId = id(form, "roleId");
      return {
        path: `/api/v1/groups/${groupId}/members`,
        method: "POST",
        body: {
          personId,
          function: fn,
          // The club's group role (P1.15 A2) wins over the function.
          ...(roleId ? { roleId } : {}),
          overCapacity: text(form, "overCapacity") === "on",
          ...(text(form, "queueBypassReason")
            ? { queueBypassReason: text(form, "queueBypassReason").slice(0, 500) }
            : {}),
        },
      };
    },
    done: (form) => `/groups/${text(form, "groupId")}/manage?member=added`,
  },
  "end-group-membership": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const membershipId = id(form, "membershipId");
      if (!groupId || !membershipId) return null;
      return {
        path: `/api/v1/groups/${groupId}/memberships/${membershipId}`,
        method: "DELETE",
      };
    },
    done: (form) => `/groups/${text(form, "groupId")}/manage?member=ended`,
  },
  "set-group-season": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const seasonId = id(form, "seasonId");
      const raw = text(form, "capacity");
      const capacity = raw === "" ? null : Number(raw);
      if (!groupId || !seasonId || (capacity !== null && !Number.isInteger(capacity))) return null;
      return {
        path: `/api/v1/groups/${groupId}/seasons/${seasonId}`,
        method: "PUT",
        body: { capacity },
      };
    },
    done: (form) => `/groups/${text(form, "groupId")}/manage?season=saved`,
  },
  "create-season": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const name = text(form, "name");
      const startsOn = text(form, "startsOn");
      const endsOn = text(form, "endsOn");
      if (!clubId || !name || !startsOn || !endsOn) return null;
      return {
        path: `/api/v1/clubs/${clubId}/seasons`,
        method: "POST",
        body: { name, startsOn, endsOn },
      };
    },
    done: (form) => withParam(back(form), "season", "created"),
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
/** Waiting lists (P1.10b): applying, answering offers, the owners' decisions. */
const entryPath = (form: FormData, what = "") => {
  const groupId = id(form, "groupId");
  const entryId = id(form, "entryId");
  return groupId && entryId ? `/api/v1/groups/${groupId}/waitlist/${entryId}${what}` : null;
};
const ownerDone = (flag: string) => (form: FormData) =>
  `/groups/${text(form, "groupId")}/waitlist?updated=${flag}`;
const turnFields = (form: FormData) => ({
  ...(text(form, "outOfOrderReason")
    ? { outOfOrderReason: text(form, "outOfOrderReason").slice(0, 500) }
    : {}),
  ...(text(form, "overCapacity") === "on" ? { overCapacity: true } : {}),
});

const WAITLIST_ACTIONS: Record<string, FormAction> = {
  "apply-waitlist": {
    call: (form) => {
      const groupId = id(form, "groupId");
      const personId = id(form, "personId");
      if (!groupId || !personId) return null;
      const note = text(form, "note").slice(0, 500);
      return {
        path: `/api/v1/groups/${groupId}/waitlist`,
        method: "POST",
        body: { personId, ...(note ? { note } : {}) },
      };
    },
    done: () => "/me/waitlists?updated=applied",
  },
  "withdraw-waitlist": {
    call: (form) => {
      const entryId = id(form, "entryId");
      return entryId ? { path: `/api/v1/me/waitlists/${entryId}/withdraw`, method: "POST" } : null;
    },
    done: () => "/me/waitlists?updated=withdrawn",
  },
  "accept-offer": {
    call: (form) => {
      const entryId = id(form, "entryId");
      return entryId ? { path: `/api/v1/me/waitlists/${entryId}/accept`, method: "POST" } : null;
    },
    done: () => "/me/waitlists?updated=accepted",
  },
  "decline-offer": {
    call: (form) => {
      const entryId = id(form, "entryId");
      return entryId ? { path: `/api/v1/me/waitlists/${entryId}/decline`, method: "POST" } : null;
    },
    done: () => "/me/waitlists?updated=declined",
  },
  "update-waitlist-entry": {
    call: (form) => {
      const path = entryPath(form);
      if (!path) return null;
      const priority = Number(text(form, "priority") || "0");
      if (!Number.isInteger(priority) || priority < 0 || priority > 100) return null;
      return {
        path,
        method: "PATCH",
        body: {
          priority,
          priorityReason:
            priority > 0 ? oneOf(WAITLIST_PRIORITY_REASONS, text(form, "priorityReason")) : null,
          ownerNote: text(form, "ownerNote").slice(0, 500) || null,
        },
      };
    },
    done: ownerDone("updated"),
  },
  "offer-place": {
    call: (form) => {
      const path = entryPath(form, "/offer");
      if (!path) return null;
      const days = Number(text(form, "replyDays"));
      return {
        path,
        method: "POST",
        body: {
          ...(Number.isInteger(days) && days >= 1 && days <= 60 ? { replyDays: days } : {}),
          ...turnFields(form),
        },
      };
    },
    done: ownerDone("offered"),
  },
  "withdraw-offer": {
    call: (form) => {
      const path = entryPath(form, "/withdraw-offer");
      return path ? { path, method: "POST" } : null;
    },
    done: ownerDone("offerWithdrawn"),
  },
  "admit-entry": {
    call: (form) => {
      const path = entryPath(form, "/admit");
      return path ? { path, method: "POST", body: turnFields(form) } : null;
    },
    done: ownerDone("admitted"),
  },
  "remove-entry": {
    call: (form) => {
      const path = entryPath(form, "/remove");
      const reason = oneOf(WAITLIST_REMOVAL_REASONS, text(form, "reason"));
      return path && reason ? { path, method: "POST", body: { reason } } : null;
    },
    done: ownerDone("removed"),
  },
};

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
  "update-club-group-settings": {
    call: (form) => {
      const clubId = id(form, "clubId");
      if (!clubId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/settings`,
        method: "PATCH",
        body: {
          ownersCanAppointCoOwners: text(form, "ownersCanAppointCoOwners") === "on",
          groupOwnersAdmitToClub: text(form, "groupOwnersAdmitToClub") === "on",
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
  // Chat (P2.1, ADR 0047): creating channels, direct messages, joining and leaving.
  "create-channel": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const groupId = id(form, "groupId");
      const name = text(form, "name").slice(0, 80);
      const visibility = text(form, "visibility") === "open" ? "open" : "closed";
      if (!clubId || !name) return null;
      const memberIds = form
        .getAll("memberId")
        .filter((v): v is string => typeof v === "string" && isUuid(v));
      const body = {
        name,
        description: optional(text(form, "description").slice(0, 500)) ?? null,
        visibility,
        memberIds,
        ...(groupId ? { everyone: form.get("everyone") === "on" } : {}),
      };
      return groupId
        ? { path: `/api/v1/clubs/${clubId}/groups/${groupId}/chats`, method: "POST", body }
        : { path: `/api/v1/clubs/${clubId}/chats`, method: "POST", body };
    },
    done: (form, result) => {
      const created = resultId(result);
      const clubId = id(form, "clubId");
      return created && clubId ? `/clubs/${clubId}/chats/${created}` : back(form);
    },
  },
  "open-direct-chat": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      if (!clubId || !personId) return null;
      return { path: `/api/v1/clubs/${clubId}/direct-chats`, method: "POST", body: { personId } };
    },
    done: (form, result) => {
      const created = resultId(result);
      const clubId = id(form, "clubId");
      return created && clubId ? `/clubs/${clubId}/chats/${created}` : back(form);
    },
  },
  "join-chat": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const chatId = id(form, "chatId");
      if (!clubId || !chatId) return null;
      return { path: `/api/v1/clubs/${clubId}/chats/${chatId}/join`, method: "POST" };
    },
    done: (form) => back(form),
  },
  "leave-chat": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const chatId = id(form, "chatId");
      if (!clubId || !chatId) return null;
      return { path: `/api/v1/clubs/${clubId}/chats/${chatId}/leave`, method: "POST" };
    },
    done: (form) => safeReturnTo(text(form, "to"), "/me/chats"),
  },
  "chat-settings": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const chatId = id(form, "chatId");
      const push = oneOf(CHAT_PUSH_SETTINGS, text(form, "push"));
      if (!clubId || !chatId || !push) return null;
      return {
        path: `/api/v1/clubs/${clubId}/chats/${chatId}/settings`,
        method: "PUT",
        body: { push },
      };
    },
    done: (form) => withParam(back(form), "saved", "1"),
  },
  // Child safety (P2.1 part B): a report of a whole chat (guardians, members).
  "report-chat": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const chatId = id(form, "chatId");
      const reason = oneOf(CHAT_REPORT_REASONS, text(form, "reason"));
      if (!clubId || !chatId || !reason) return null;
      const note = text(form, "note").slice(0, 1000);
      return {
        path: `/api/v1/clubs/${clubId}/chats/${chatId}/reports`,
        method: "POST",
        body: { reason, ...(note ? { note } : {}) },
      };
    },
    done: (form) => withParam(back(form), "reported", "1"),
  },
  // Safeguarding cases (P2.1 part B): the club's safeguarding officers.
  "safeguarding-request-read": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const reportId = id(form, "reportId");
      if (!clubId || !reportId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/safeguarding/reports/${reportId}/reads`,
        method: "POST",
      };
    },
    done: (form) => back(form),
  },
  "safeguarding-confirm-read": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const reportId = id(form, "reportId");
      const readId = id(form, "readId");
      if (!clubId || !reportId || !readId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/safeguarding/reports/${reportId}/reads/${readId}/confirm`,
        method: "POST",
      };
    },
    done: (form) => back(form),
  },
  "safeguarding-hide": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const reportId = id(form, "reportId");
      const messageId = id(form, "messageId");
      if (!clubId || !reportId || !messageId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/safeguarding/reports/${reportId}/hide`,
        method: "POST",
        body: { messageId },
      };
    },
    done: (form) => back(form),
  },
  "safeguarding-close": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const reportId = id(form, "reportId");
      const outcome = oneOf(CHAT_REPORT_OUTCOMES, text(form, "outcome"));
      if (!clubId || !reportId || !outcome) return null;
      const note = text(form, "note").slice(0, 1000);
      return {
        path: `/api/v1/clubs/${clubId}/safeguarding/reports/${reportId}/close`,
        method: "POST",
        body: { outcome, ...(note ? { note } : {}) },
      };
    },
    done: (form) => back(form),
  },
  "safeguarding-mute": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      const hours = Number.parseInt(text(form, "hours"), 10);
      if (!clubId || !personId || !Number.isInteger(hours) || hours < 1 || hours > 720) return null;
      const reportId = id(form, "reportId");
      return {
        path: `/api/v1/clubs/${clubId}/safeguarding/mutes`,
        method: "POST",
        body: { personId, hours, ...(reportId ? { reportId } : {}) },
      };
    },
    done: (form) => back(form),
  },
  "safeguarding-unmute": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const muteId = id(form, "muteId");
      if (!clubId || !muteId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/safeguarding/mutes/${muteId}`,
        method: "DELETE",
      };
    },
    done: (form) => back(form),
  },
  "update-chat": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const chatId = id(form, "chatId");
      if (!clubId || !chatId) return null;
      const body: Record<string, unknown> = {};
      const name = text(form, "name").slice(0, 80);
      if (name) body.name = name;
      const archived = text(form, "archived");
      if (archived === "true" || archived === "false") body.archived = archived === "true";
      if (Object.keys(body).length === 0) return null;
      return { path: `/api/v1/clubs/${clubId}/chats/${chatId}`, method: "PATCH", body };
    },
    done: (form) => back(form),
  },
  "add-chat-members": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const chatId = id(form, "chatId");
      const personIds = form
        .getAll("memberId")
        .filter((v): v is string => typeof v === "string" && isUuid(v));
      if (!clubId || !chatId || personIds.length === 0) return null;
      return {
        path: `/api/v1/clubs/${clubId}/chats/${chatId}/members`,
        method: "POST",
        body: { personIds },
      };
    },
    done: (form) => back(form),
  },
  "remove-chat-member": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const chatId = id(form, "chatId");
      const personId = id(form, "personId");
      if (!clubId || !chatId || !personId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/chats/${chatId}/members/${personId}`,
        method: "DELETE",
      };
    },
    done: (form) => back(form),
  },
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

/** Privacy (P1.8a): consents, leaving a club, stepping down, the board's decisions. */
const PRIVACY_ACTIONS: Record<string, FormAction> = {
  "give-consent": {
    call: (form) => {
      const personId = id(form, "personId");
      const clubId = id(form, "clubId");
      const purpose = text(form, "purpose");
      // A paper consent names the version per purpose (the purpose is chosen in the form).
      const textVersion = text(form, "textVersion") || text(form, `version.${purpose}`);
      if (!personId || !clubId || !(CONSENT_PURPOSES as readonly string[]).includes(purpose)) {
        return null;
      }
      const clubNote = optional(text(form, "clubNote"));
      return {
        path: `/api/v1/people/${personId}/consents/${purpose}?clubId=${clubId}`,
        method: "PUT",
        body: { textVersion, ...(clubNote ? { clubNote } : {}) },
      };
    },
    done: (form) => withParam(back(form, "/me/privacy"), "consent", "given"),
  },
  "withdraw-consent": {
    call: (form) => {
      const personId = id(form, "personId");
      const clubId = id(form, "clubId");
      const purpose = text(form, "purpose");
      if (!personId || !clubId || !(CONSENT_PURPOSES as readonly string[]).includes(purpose)) {
        return null;
      }
      return {
        path: `/api/v1/people/${personId}/consents/${purpose}?clubId=${clubId}`,
        method: "DELETE",
      };
    },
    done: (form) => withParam(back(form, "/me/privacy"), "consent", "withdrawn"),
  },
  "step-down": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const assignmentId = id(form, "assignmentId");
      const personId = id(form, "personId");
      if (!clubId || !assignmentId) return null;
      return {
        path: `/api/v1/me/clubs/${clubId}/assignments/${assignmentId}${personId ? `?personId=${personId}` : ""}`,
        method: "DELETE",
      };
    },
    done: (form) => withParam(back(form, "/me/privacy"), "steppedDown", "1"),
  },
  "leave-club": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      if (!clubId || !personId || text(form, "confirm") !== "on") return null;
      return {
        path: `/api/v1/me/clubs/${clubId}/leave`,
        method: "POST",
        body: { personId, removeNow: text(form, "removeNow") === "on" },
      };
    },
    done: () => "/me/privacy?left=1",
  },
  // "Download my data" and erasure (P1.8b).
  "request-export": {
    call: (form) => {
      const personId = id(form, "personId");
      return {
        path: "/api/v1/me/data-exports",
        method: "POST",
        body: personId ? { personId } : {},
      };
    },
    done: () => "/me/privacy?exported=1#exports",
  },
  "schedule-deletion": {
    call: (form) => {
      if (text(form, "confirm") !== "on") return null;
      const eraseWardIds = form
        .getAll("eraseWard")
        .filter((v): v is string => typeof v === "string" && isUuid(v));
      return { path: "/api/v1/me/account/deletion", method: "POST", body: { eraseWardIds } };
    },
    done: () => "/me/privacy/delete",
  },
  "cancel-deletion": {
    call: () => ({ path: "/api/v1/me/account/deletion", method: "DELETE" }),
    done: (form) => withParam(back(form, "/me/privacy/delete"), "cancelled", "1"),
  },
  "schedule-ward-erasure": {
    call: (form) => {
      const personId = id(form, "personId");
      if (!personId || text(form, "confirm") !== "on") return null;
      return { path: `/api/v1/me/wards/${personId}/erasure`, method: "POST" };
    },
    done: (form) => `/me/family/${id(form, "personId") ?? ""}/erase`,
  },
  "cancel-ward-erasure": {
    call: (form) => {
      const personId = id(form, "personId");
      if (!personId) return null;
      return { path: `/api/v1/me/wards/${personId}/erasure`, method: "DELETE" };
    },
    done: (form) => `/me/family/${id(form, "personId") ?? ""}/erase?cancelled=1`,
  },
  "record-decision": {
    call: (form) => {
      const clubId = id(form, "clubId");
      if (!clubId) return null;
      const settings: Record<string, unknown> = {};
      for (const key of BOARD_SETTING_KEYS) {
        if (form.get(`change.${key}`) !== "on") continue;
        const definition: ClubSettingDefinition = CLUB_SETTINGS[key];
        if (definition.type === "integer") settings[key] = Number(text(form, `value.${key}`));
        else if (definition.type === "boolean") settings[key] = form.get(`value.${key}`) === "on";
        else if (definition.type === "purposes") {
          settings[key] = form
            .getAll(`value.${key}`)
            .filter((p) => (CONSENT_PURPOSES as readonly unknown[]).includes(p));
        }
      }
      return {
        path: `/api/v1/clubs/${clubId}/setting-decisions`,
        method: "POST",
        body: {
          body: text(form, "body"),
          decidedOn: text(form, "decidedOn"),
          reference: text(form, "reference"),
          ...(optional(text(form, "effectiveFrom"))
            ? { effectiveFrom: text(form, "effectiveFrom") }
            : {}),
          settings,
        },
      };
    },
    done: (form) => withParam(back(form), "decided", "1"),
  },
  "set-privacy-contact": {
    call: (form) => {
      const clubId = id(form, "clubId");
      if (!clubId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/settings`,
        method: "PATCH",
        body: { privacyContactEmail: text(form, "privacyContactEmail") || null },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "publish-consent-text": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const purpose = text(form, "purpose");
      if (!clubId || !(CONSENT_PURPOSES as readonly string[]).includes(purpose)) return null;
      const texts: Record<string, string> = {};
      for (const locale of ["sv", "en", "nb"]) {
        const value = text(form, `text.${locale}`);
        if (value) texts[locale] = value;
      }
      return {
        path: `/api/v1/clubs/${clubId}/consent-texts`,
        method: "POST",
        body: { purpose, texts },
      };
    },
    done: (form) => withParam(back(form), "published", "1"),
  },
};

/** Protected identity (P1.12): the flags and the club's logging mode. */
const PROTECTION_ACTIONS: Record<string, FormAction> = {
  "set-protection": {
    call: (form) => {
      const personId = id(form, "personId");
      const value = text(form, "protected");
      if (!personId || (value !== "1" && value !== "0")) return null;
      const clubId = id(form, "clubId");
      return {
        path: `/api/v1/people/${personId}/protection${clubId ? `?clubId=${clubId}` : ""}`,
        method: "PUT",
        body: { protected: value === "1" },
      };
    },
    done: (form) => {
      const on = text(form, "protected") === "1";
      const path = withParam(back(form), "protection", on ? "on" : "off");
      // A guardian who protected a child is asked to protect themselves too.
      return on && text(form, "ward") === "1" ? withParam(path, "protectedChild", "1") : path;
    },
  },
  "set-profile-view-logging": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const mode = text(form, "mode");
      if (!clubId || (mode !== "protected_only" && mode !== "all")) return null;
      return {
        path: `/api/v1/clubs/${clubId}/profile-view-logging`,
        method: "PUT",
        body: { mode },
      };
    },
    done: (form) => withParam(back(form), "saved", "1"),
  },
};

/** Billing (P1.13; BILLING_ENABLED only): the club's choice and details, the operators' tools. */
const PLAN_KEY = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const BILLING_ACTIONS: Record<string, FormAction> = {
  "select-plan": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const planKey = text(form, "planKey");
      const period = text(form, "billingPeriod");
      const addOns = form
        .getAll("addOn")
        .filter((a): a is string => typeof a === "string" && PLAN_KEY.test(a));
      if (!clubId || !PLAN_KEY.test(planKey) || (period !== "month" && period !== "year"))
        return null;
      return {
        path: `/api/v1/clubs/${clubId}/subscription/selection`,
        method: "PUT",
        body: {
          planKey,
          addOns,
          billingPeriod: period,
          acceptTerms: text(form, "acceptTerms") === "1",
          startNow: text(form, "startNow") === "1",
        },
      };
    },
    done: (form) => withParam(back(form), "saved", "plan"),
  },
  "cancel-subscription": {
    call: (form) => {
      const clubId = id(form, "clubId");
      if (!clubId) return null;
      return { path: `/api/v1/clubs/${clubId}/subscription/cancel`, method: "POST", body: {} };
    },
    done: (form) => withParam(back(form), "saved", "cancelled"),
  },
  "resume-subscription": {
    call: (form) => {
      const clubId = id(form, "clubId");
      if (!clubId) return null;
      return { path: `/api/v1/clubs/${clubId}/subscription/resume`, method: "POST", body: {} };
    },
    done: (form) => withParam(back(form), "saved", "resumed"),
  },
  "save-billing-account": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const locale = text(form, "invoiceLocale");
      if (!clubId || !["sv", "en", "nb"].includes(locale)) return null;
      return {
        path: `/api/v1/clubs/${clubId}/billing/account`,
        method: "PUT",
        body: {
          legalName: text(form, "legalName"),
          organizationNumber: optional(text(form, "organizationNumber")) ?? null,
          vatNumber: optional(text(form, "vatNumber").toUpperCase().replace(/\s/g, "")) ?? null,
          address: {
            street: text(form, "street"),
            postalCode: text(form, "postalCode"),
            city: text(form, "city"),
            country: text(form, "country").toUpperCase(),
          },
          invoiceEmail: text(form, "invoiceEmail"),
          reference: optional(text(form, "reference")) ?? null,
          invoiceLocale: locale,
        },
      };
    },
    done: (form) => withParam(back(form), "saved", "account"),
  },
  "set-payment-method": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const method = text(form, "method");
      if (!clubId || (method !== "invoice" && method !== "card")) return null;
      return {
        path: `/api/v1/clubs/${clubId}/billing/payment-method`,
        method: "POST",
        body: { method },
      };
    },
    done: (form) => withParam(back(form), "saved", "method"),
  },
  // Card (part B): the API answers with the provider's page (route: externalRedirect).
  "pay-invoice": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const invoiceId = id(form, "invoiceId");
      if (!clubId || !invoiceId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/invoices/${invoiceId}/pay`,
        method: "POST",
        body: {},
      };
    },
    done: (form) => back(form),
  },
  // Operators (P1.13, /ops/billing).
  "ops-record-payment": {
    call: (form) => {
      const invoiceId = id(form, "invoiceId");
      const amount = Number(text(form, "amount").replace(",", "."));
      const receivedOn = text(form, "receivedOn");
      const reference = text(form, "reference");
      if (!invoiceId || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) || !reference) {
        return null;
      }
      return {
        path: `/api/v1/billing/invoices/${invoiceId}/payments`,
        method: "POST",
        body: { amountMinor: Math.round(amount * 100), receivedOn, reference },
      };
    },
    done: (form) => withParam(back(form), "saved", "payment"),
  },
  "ops-credit-note": {
    call: (form) => {
      const invoiceId = id(form, "invoiceId");
      const reason = text(form, "reason");
      const lines = form
        .getAll("line")
        .map((l) => Number(l))
        .filter((l) => Number.isInteger(l) && l >= 0);
      if (
        !invoiceId ||
        !["duplicate", "wrong_amount", "goodwill", "cancelled", "other"].includes(reason)
      ) {
        return null;
      }
      return {
        path: `/api/v1/billing/invoices/${invoiceId}/credit-note`,
        method: "POST",
        body: { reason, ...(lines.length > 0 ? { lines } : {}) },
      };
    },
    done: (form) => withParam(back(form), "saved", "credit"),
  },
  "ops-resend-invoice": {
    call: (form) => {
      const invoiceId = id(form, "invoiceId");
      if (!invoiceId) return null;
      return { path: `/api/v1/billing/invoices/${invoiceId}/resend`, method: "POST", body: {} };
    },
    done: (form) => withParam(back(form), "saved", "resent"),
  },
  "ops-set-trial": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const day = text(form, "trialEndsOn");
      if (!clubId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
      return {
        path: `/api/v1/clubs/${clubId}/subscription/trial`,
        method: "PUT",
        body: { trialEndsAt: new Date(`${day}T23:00:00Z`).toISOString() },
      };
    },
    done: (form) => withParam(back(form), "saved", "trial"),
  },
  "ops-assign-plan": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const planKey = text(form, "planKey");
      if (!clubId || !PLAN_KEY.test(planKey)) return null;
      const addOns = form
        .getAll("addOn")
        .filter((a): a is string => typeof a === "string" && PLAN_KEY.test(a));
      return {
        path: `/api/v1/clubs/${clubId}/subscription`,
        method: "PUT",
        body: { planKey, addOns },
      };
    },
    done: (form) => withParam(back(form), "saved", "plan"),
  },
  "ops-subscription-status": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const status = text(form, "status");
      if (!clubId || !["trial", "active", "past_due", "read_only", "cancelled"].includes(status))
        return null;
      return {
        path: `/api/v1/clubs/${clubId}/subscription/status`,
        method: "PUT",
        body: { status },
      };
    },
    done: (form) => withParam(back(form), "saved", "status"),
  },
  // Club types and their templates (P1.15 B, /ops/club-types).
  "ops-create-club-type": {
    call: (form) => {
      const names = typeNames(form);
      const key = text(form, "key");
      return names && /^[a-z][a-z0-9_]{1,39}$/.test(key)
        ? {
            path: "/api/v1/ops/club-types",
            method: "POST",
            body: { key, names, descriptions: typeDescriptions(form) },
          }
        : null;
    },
    done: (_form, result) => {
      const typeId = resultId(result);
      return typeId ? `/ops/club-types/${typeId}?saved=1` : "/ops/club-types?saved=1";
    },
  },
  "ops-update-club-type": {
    call: (form) => {
      const typeId = id(form, "clubTypeId");
      const names = typeNames(form);
      const sortOrder = Number.parseInt(text(form, "sortOrder"), 10);
      return typeId && names
        ? {
            path: `/api/v1/ops/club-types/${typeId}`,
            method: "PATCH",
            body: {
              names,
              descriptions: typeDescriptions(form) ?? null,
              active: form.get("active") === "on",
              ...(Number.isFinite(sortOrder) ? { sortOrder } : {}),
            },
          }
        : null;
    },
    done: (form) => withParam(back(form), "saved", "1"),
  },
  "ops-create-club-type-role": {
    call: (form) => {
      const typeId = id(form, "clubTypeId");
      const key = text(form, "key");
      const scope = text(form, "scope");
      if (!typeId || !/^[a-z][a-z0-9_]{1,39}$/.test(key)) return null;
      if (scope !== "club" && scope !== "group") return null;
      const names = typeNames(form);
      return {
        path: `/api/v1/ops/club-types/${typeId}/roles`,
        method: "POST",
        body: { key, scope, ...(names ? { names } : {}), permissions: permissionsOf(form) },
      };
    },
    done: (form) => withParam(back(form), "saved", "1"),
  },
  "ops-update-club-type-role": {
    call: (form) => {
      const typeId = id(form, "clubTypeId");
      const roleId = id(form, "roleId");
      if (!typeId || !roleId) return null;
      return {
        path: `/api/v1/ops/club-types/${typeId}/roles/${roleId}`,
        method: "PATCH",
        // Without all three names a template role uses the catalogue's name (known keys).
        body: { names: typeNames(form), permissions: permissionsOf(form) },
      };
    },
    done: (form) => withParam(back(form), "saved", "1"),
  },
  "ops-delete-club-type-role": {
    call: (form) => {
      const typeId = id(form, "clubTypeId");
      const roleId = id(form, "roleId");
      return typeId && roleId
        ? { path: `/api/v1/ops/club-types/${typeId}/roles/${roleId}`, method: "DELETE" }
        : null;
    },
    done: (form) => withParam(back(form), "saved", "1"),
  },
  "ops-plan-active": {
    call: (form) => {
      const planId = id(form, "planId");
      const active = text(form, "active");
      if (!planId || (active !== "1" && active !== "0")) return null;
      return {
        path: `/api/v1/billing/plans/${planId}`,
        method: "PATCH",
        body: { active: active === "1" },
      };
    },
    done: (form) => withParam(back(form), "saved", "plans"),
  },
};

/** Calendar subscriptions (P1.11): creating and new links go through app/actions/calendar-feed. */
const CALENDAR_ACTIONS: Record<string, FormAction> = {
  "rename-calendar-feed": {
    call: (form) => {
      const feedId = id(form, "feedId");
      const label = text(form, "label");
      if (!feedId || label.length > 60) return null;
      return {
        path: `/api/v1/me/calendar-feeds/${feedId}`,
        method: "PATCH",
        body: { label: label || null },
      };
    },
    done: () => "/me/calendar?updated=1",
  },
  "remove-calendar-feed": {
    call: (form) => {
      const feedId = id(form, "feedId");
      return feedId ? { path: `/api/v1/me/calendar-feeds/${feedId}`, method: "DELETE" } : null;
    },
    done: () => "/me/calendar?removed=1",
  },
};

export const FORM_ACTIONS: Record<string, FormAction> = {
  ...FAMILY_ACTIONS,
  ...BILLING_ACTIONS,
  ...CALENDAR_ACTIONS,
  ...PROTECTION_ACTIONS,
  ...PRIVACY_ACTIONS,
  ...NOTIFICATION_ACTIONS,
  ...CLUB_ACTIONS,
  ...GROUP_ACTIONS,
  ...WAITLIST_ACTIONS,
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
        secondAdministratorEmail: optional(text(form, "secondAdministratorEmail")),
        clubTypeId: id(form, "clubTypeId") ?? undefined,
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
  // Club-defined roles (P1.15 A2).
  "copy-template-role": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const scope = text(form, "scope");
      const key = text(form, "key");
      if (!clubId || (scope !== "club" && scope !== "group") || !/^[a-z0-9_]{2,40}$/.test(key)) {
        return null;
      }
      return {
        path: `/api/v1/clubs/${clubId}/roles/from-template`,
        method: "POST",
        body: { scope, key },
      };
    },
    done: (form) => withParam(back(form), "copied", "1"),
  },
  "create-role": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const scope = text(form, "scope");
      const names = roleNames(form);
      if (!clubId || (scope !== "club" && scope !== "group") || !names) return null;
      return {
        path: `/api/v1/clubs/${clubId}/roles`,
        method: "POST",
        body: { scope, names, permissions: permissionsOf(form) },
      };
    },
    done: (form, result) => {
      const roleId = (result as { id?: string } | null)?.id;
      return roleId ? `/clubs/${text(form, "clubId")}/roles/${roleId}?saved=1` : back(form);
    },
  },
  "update-role": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const roleId = id(form, "roleId");
      const version = Number(text(form, "version"));
      if (!clubId || !roleId || !Number.isInteger(version)) return null;
      const reset = text(form, "reset") === "1";
      const names = roleNames(form);
      return {
        path: `/api/v1/clubs/${clubId}/roles/${roleId}`,
        method: "PATCH",
        body: reset
          ? { version, resetToTemplate: true }
          : {
              version,
              names,
              permissions: permissionsOf(form),
            },
      };
    },
    done: (form) => `/clubs/${text(form, "clubId")}/roles/${text(form, "roleId")}?saved=1`,
  },
  "delete-role": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const roleId = id(form, "roleId");
      if (!clubId || !roleId) return null;
      const replacement = id(form, "replacementRoleId");
      return {
        path: `/api/v1/clubs/${clubId}/roles/${roleId}${replacement ? `?replacementRoleId=${replacement}` : ""}`,
        method: "DELETE",
      };
    },
    done: (form) => `/clubs/${text(form, "clubId")}/roles?deleted=1`,
  },
  "assign-club-role": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      const roleId = id(form, "roleId");
      return clubId && personId && roleId
        ? {
            path: `/api/v1/clubs/${clubId}/role-assignments`,
            method: "POST",
            body: { personId, roleId },
          }
        : null;
    },
    done: (form) => withParam(back(form), "role", "assigned"),
  },
  "unassign-club-role": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const assignmentId = id(form, "assignmentId");
      return clubId && assignmentId
        ? { path: `/api/v1/clubs/${clubId}/role-assignments/${assignmentId}`, method: "DELETE" }
        : null;
    },
    done: (form) => withParam(back(form), "role", "ended"),
  },
  // At least two administrators (P1.15 A3).
  "start-suspension": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      const reason = text(form, "reason");
      return clubId && personId && ["compromised", "left_task", "other"].includes(reason)
        ? {
            path: `/api/v1/clubs/${clubId}/administrators/${personId}/suspensions`,
            method: "POST",
            body: {
              reason,
              note: optional(text(form, "note")),
              demote: form.get("demote") === "on",
            },
          }
        : null;
    },
    done: (form) => withParam(back(form), "suspension", "requested"),
  },
  "confirm-suspension": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const suspensionId = id(form, "suspensionId");
      return clubId && suspensionId
        ? {
            path: `/api/v1/clubs/${clubId}/administrator-suspensions/${suspensionId}/confirm`,
            method: "POST",
            body: {},
          }
        : null;
    },
    done: (form) => withParam(back(form), "suspension", "confirmed"),
  },
  "cancel-suspension": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const suspensionId = id(form, "suspensionId");
      return clubId && suspensionId
        ? {
            path: `/api/v1/clubs/${clubId}/administrator-suspensions/${suspensionId}/cancel`,
            method: "POST",
            body: {},
          }
        : null;
    },
    done: (form) => withParam(back(form), "suspension", "cancelled"),
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
