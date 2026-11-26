// SPDX-License-Identifier: AGPL-3.0-only
// The activity form's logic (P2.7g), apart from the screen so it is tested
// on its own: the title that follows the kind (P2.7e), who is left out of
// the call-up, the request body from local dates and times in the club's
// time zone, and the car pool's default return time.

import { localDate, localTime, zonedTime } from "@clubadmin/shared";

export const KINDS = ["training", "match", "meeting", "other"] as const;
export type Kind = (typeof KINDS)[number];
export const HOME_AWAY_VALUES = ["home", "away", "neutral"] as const;
export const TRANSPORT_VALUES = ["own", "shared"] as const;
export const RESPONSE_MODE_VALUES = ["none", "optional", "requested"] as const;

/** The name an activity of a kind takes when no title is written. */
export function kindTitle(kind: Kind, kindLabel: string, titles: Record<Kind, string>): string {
  return kind === "other" && kindLabel.trim() ? kindLabel.trim() : titles[kind];
}

/**
 * The title after the kind (or what "other" is called) changed: it follows
 * the kind while it is empty or still a kind's name, else the person's own.
 */
export function followTitle(
  title: string,
  previousKindTitle: string,
  nextKindTitle: string,
  titles: Record<Kind, string>,
): string {
  const auto =
    title.trim() === "" || title === previousKindTitle || Object.values(titles).includes(title);
  return auto ? nextKindTitle : title;
}

/** Those offered in the call-up list but not ticked: `notCalledUp`. */
export function leftOut(candidates: readonly string[], ticked: ReadonlySet<string>): string[] {
  return [...new Set(candidates.filter((id) => !ticked.has(id)))];
}

export interface ActivityValues {
  kind: Kind;
  kindLabel: string;
  title: string;
  /** Local date and times in the club's zone. */
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  meetTime: string;
  meetPlace: string;
  /** A club place, or "" for the free text. */
  locationId: string;
  locationText: string;
  opponent: string;
  homeAway: "" | (typeof HOME_AWAY_VALUES)[number];
  competition: string;
  responseMode: (typeof RESPONSE_MODE_VALUES)[number];
  respondByDate: string;
  respondByTime: string;
  transportMode: "" | (typeof TRANSPORT_VALUES)[number];
  carpoolReturnMinutes: string;
  notes: string;
  leaderNotes: string;
}

/** A new activity's values: tomorrow 18:00–19:30, a match as on the web. */
export function newActivityValues(
  now: Date,
  timeZone: string,
  titles: Record<Kind, string>,
): ActivityValues {
  return {
    kind: "match",
    kindLabel: "",
    title: titles.match,
    date: localDate(new Date(now.getTime() + 86_400_000), timeZone),
    startTime: "18:00",
    endTime: "19:30",
    allDay: false,
    meetTime: "",
    meetPlace: "",
    locationId: "",
    locationText: "",
    opponent: "",
    homeAway: "",
    competition: "",
    responseMode: "requested",
    respondByDate: "",
    respondByTime: "",
    transportMode: "",
    carpoolReturnMinutes: "",
    notes: "",
    leaderNotes: "",
  };
}

/** The fields of an activity as the API returns it, for editing. */
export interface ActivityLike {
  kind: string;
  kindLabel?: string | null;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  meetAt: string | null;
  meetPlace: string | null;
  location: { id: string } | null;
  locationText: string | null;
  opponent: string | null;
  homeAway: string | null;
  competition: string | null;
  responseMode?: string;
  respondBy?: string | null;
  transportMode?: string | null;
  carpoolReturnMinutes?: number | null;
  notes: string | null;
  leaderNotes?: string | null;
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;

export function activityValuesOf(a: ActivityLike, timeZone: string): ActivityValues {
  const start = new Date(a.startsAt);
  const respondBy = a.respondBy ? new Date(a.respondBy) : null;
  return {
    kind: oneOf(KINDS, a.kind, "other"),
    kindLabel: a.kindLabel ?? "",
    title: a.title,
    date: localDate(start, timeZone),
    startTime: localTime(start, timeZone),
    endTime: localTime(new Date(a.endsAt), timeZone),
    allDay: a.allDay,
    meetTime: a.meetAt ? localTime(new Date(a.meetAt), timeZone) : "",
    meetPlace: a.meetPlace ?? "",
    locationId: a.location?.id ?? "",
    locationText: a.locationText ?? "",
    opponent: a.opponent ?? "",
    homeAway: oneOf(["", ...HOME_AWAY_VALUES] as const, a.homeAway ?? "", ""),
    competition: a.competition ?? "",
    responseMode: oneOf(RESPONSE_MODE_VALUES, a.responseMode, "none"),
    respondByDate: respondBy ? localDate(respondBy, timeZone) : "",
    respondByTime: respondBy ? localTime(respondBy, timeZone) : "",
    transportMode: oneOf(["", ...TRANSPORT_VALUES] as const, a.transportMode ?? "", ""),
    carpoolReturnMinutes:
      a.carpoolReturnMinutes === null || a.carpoolReturnMinutes === undefined
        ? ""
        : String(a.carpoolReturnMinutes),
    notes: a.notes ?? "",
    leaderNotes: a.leaderNotes ?? "",
  };
}

type Body = Record<string, unknown>;

/**
 * The request body (POST, or PATCH with `clear`: empty fields are cleared),
 * or the fields found wrong before sending (codes as the API's).
 */
export function activityBody(
  v: ActivityValues,
  timeZone: string,
  titles: Record<Kind, string>,
  clear: boolean,
): { body: Body } | { fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const at = (date: string, time: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)
      ? (zonedTime(date, time, timeZone)?.toISOString() ?? null)
      : null;
  const startsAt = v.allDay ? at(v.date, "00:00") : at(v.date, v.startTime);
  const endsAt = v.allDay ? at(v.date, "23:59") : at(v.date, v.endTime);
  if (!startsAt) fields.startsAt = v.allDay ? "invalid_date" : "invalid_time";
  if (!endsAt) fields.endsAt = "invalid_time";
  if (startsAt && endsAt && endsAt <= startsAt) fields.endsAt = "event_period_invalid";
  const meetAt = v.meetTime && !v.allDay ? at(v.date, v.meetTime) : null;
  const respondBy = v.respondByDate ? at(v.respondByDate, v.respondByTime || "23:59") : null;
  if (startsAt && respondBy && respondBy > startsAt) fields.respondBy = "respond_by_after_start";
  const minutes = v.carpoolReturnMinutes.trim();
  const returnMinutes = minutes === "" ? null : Number(minutes);
  if (
    returnMinutes !== null &&
    !(Number.isInteger(returnMinutes) && returnMinutes >= 0 && returnMinutes <= 240)
  ) {
    fields.carpoolReturnMinutes = "invalid_number";
  }
  if (Object.keys(fields).length > 0) return { fields };
  const text = (name: string, value: string): Body =>
    value.trim() ? { [name]: value.trim() } : clear ? { [name]: null } : {};
  const nullable = (name: string, value: unknown): Body =>
    value !== null && value !== "" ? { [name]: value } : clear ? { [name]: null } : {};
  const kindLabel = v.kind === "other" ? v.kindLabel : "";
  return {
    body: {
      kind: v.kind,
      ...text("kindLabel", kindLabel),
      title: v.title.trim() || kindTitle(v.kind, v.kindLabel, titles),
      startsAt,
      endsAt,
      ...(clear ? {} : { allDay: v.allDay }),
      ...nullable("meetAt", meetAt),
      ...text("meetPlace", v.meetPlace),
      ...(v.locationId
        ? { locationId: v.locationId, ...(clear ? { locationText: null } : {}) }
        : { ...text("locationText", v.locationText), ...(clear ? { locationId: null } : {}) }),
      ...text("opponent", v.opponent),
      ...nullable("homeAway", v.homeAway),
      ...text("competition", v.competition),
      responseMode: v.responseMode,
      ...nullable("respondBy", v.responseMode === "none" ? null : respondBy),
      ...nullable("transportMode", v.transportMode),
      ...nullable("carpoolReturnMinutes", returnMinutes),
      ...text("notes", v.notes),
      ...text("leaderNotes", v.leaderNotes),
    },
  };
}

/**
 * The form's field for a request field (first path segment): local and API
 * errors use the API's names; these are shown elsewhere.
 */
export const ACTIVITY_FIELD_OF: Record<string, keyof ActivityValues> = {
  startsAt: "startTime",
  endsAt: "endTime",
  meetAt: "meetTime",
  respondBy: "respondByDate",
  notCalledUp: "title",
};

/** Field codes by the form's field names. */
export function errorsByField(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, code] of Object.entries(fields)) {
    const field = ACTIVITY_FIELD_OF[name] ?? name;
    if (!(field in out)) out[field] = code;
  }
  return out;
}

/**
 * When the way home leaves by default (P2.7f): the car pool's
 * `defaultReturnAt` (the activity's, the driver's, the club's or 15 minutes
 * after the end, decided by the API), else the end plus the minutes.
 */
export function defaultReturnTime(
  defaultReturnAt: string | null | undefined,
  endsAt: string | null,
  timeZone: string,
  minutes = 15,
): string {
  if (defaultReturnAt) return localTime(new Date(defaultReturnAt), timeZone);
  if (!endsAt) return "";
  return localTime(new Date(new Date(endsAt).getTime() + minutes * 60_000), timeZone);
}

/**
 * A local time on the activity's day (in the club's zone) as an instant, or
 * null when empty; a time before the activity's start belongs to the next day
 * only for the way home (it never leaves before the activity starts).
 */
export function timeOnDay(
  time: string,
  activityStartsAt: string,
  timeZone: string,
  after?: string | null,
): string | null {
  if (!/^\d{2}:\d{2}$/.test(time)) return null;
  const day = localDate(new Date(activityStartsAt), timeZone);
  const at = zonedTime(day, time, timeZone);
  if (!at) return null;
  if (after && at.getTime() < new Date(after).getTime()) {
    return new Date(at.getTime() + 86_400_000).toISOString();
  }
  return at.toISOString();
}
