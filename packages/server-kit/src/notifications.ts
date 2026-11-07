// SPDX-License-Identifier: AGPL-3.0-only
// Notifications (P1.7, ADR 0039) for the API and the worker: configuration,
// unsubscribe tokens, sealed push tokens and the texts of a notice. A
// notice's text is rendered when it is read (inbox) or sent (email, push)
// from its type and params, which hold IDs, enum values, counts, times and
// titles of activities or events: never people's names, notes or addresses.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { type Catalogue, catalogues, type Locale } from "@clubadmin/i18n";
import {
  isNotificationType,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  z,
} from "@clubadmin/shared";
import { IntlMessageFormat } from "intl-messageformat";

/** Settings shared by the API and the worker. */
export const notificationsConfigShape = {
  /** Signs unsubscribe links and seals push tokens (at least 32 characters; required with SMTP_URL or PUSH_PROVIDER). */
  NOTIFICATION_TOKEN_KEY: z.string().min(32).optional(),
  /** expo: Expo Push; fake: records pushes without sending (development, CI); unset: no push. */
  PUSH_PROVIDER: z.enum(["expo", "fake"]).optional(),
  /** Expo's access token when the project requires one for sending. */
  EXPO_ACCESS_TOKEN: z.string().optional(),
  /** Pushes per person per hour; beyond it only the inbox gets them. */
  NOTIFY_PUSH_PER_PERSON_HOUR: z.coerce.number().int().min(1).max(1000).default(10),
};

// --- Unsubscribe tokens --------------------------------------------------------------

const sign = (key: string, accountId: string, category: string) =>
  createHmac("sha256", key)
    .update(`unsubscribe:${accountId}:${category}`, "utf8")
    .digest("base64url");

/** "<accountId>.<category>.<HMAC>": never stored; rotating the key invalidates old links. */
export const unsubscribeToken = (key: string, accountId: string, category: NotificationCategory) =>
  `${accountId}.${category}.${sign(key, accountId, category)}`;

export function verifyUnsubscribeToken(
  key: string,
  token: string,
): { accountId: string; category: NotificationCategory } | null {
  const [accountId, category, mac, ...rest] = token.split(".");
  if (!accountId || !category || !mac || rest.length > 0) return null;
  if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) return null;
  if (!z.uuid().safeParse(accountId).success) return null;
  const expected = Buffer.from(sign(key, accountId, category));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { accountId, category: category as NotificationCategory };
}

export const unsubscribeUrl = (webUrl: string, token: string) =>
  new URL(`/unsubscribe?token=${encodeURIComponent(token)}`, webUrl).toString();

// --- Push tokens ---------------------------------------------------------------------

const pushKey = (key: string) =>
  Buffer.from(hkdfSync("sha256", key, "clubadmin", "push-token", 32));

/** sha256 of a push token: the lookup key of push_devices. */
export const hashPushToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("base64url");

/** AES-256-GCM with a key derived from NOTIFICATION_TOKEN_KEY: "v1.<iv>.<tag>.<ciphertext>". */
export function sealPushToken(key: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pushKey(key), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function openPushToken(key: string, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("not a sealed push token");
  const decipher = createDecipheriv("aes-256-gcm", pushKey(key), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// --- Texts ---------------------------------------------------------------------------

export interface NoticeInput {
  type: string;
  clubId: string | null;
  clubName: string | null;
  subjectType: string;
  subjectId: string | null;
  params: Record<string, unknown>;
}

export interface NoticeText {
  title: string;
  body: string;
  /** A path with IDs only, for the web and the app's deep links. */
  link: string;
}

function lookup(catalogue: Catalogue, key: string): string | undefined {
  let node: string | Catalogue | undefined = catalogue;
  for (const part of key.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** An ICU message in the locale (Norwegian falls back to English per message), or "" when missing. */
export function message(locale: Locale, key: string, values: Record<string, string>): string {
  const text = lookup(catalogues[locale], key) ?? lookup(catalogues.en, key);
  return text ? String(new IntlMessageFormat(text, locale).format(values)) : "";
}

/** Params are strings, numbers or booleans; anything else is left out. */
const str = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";

/** A time in the club's time zone, e.g. "tis 4 nov. 17:30". */
/** An amount in minor units (billing notices). */
export function formatAmount(locale: Locale, minor: unknown, currency: unknown): string {
  if (typeof minor !== "number" || typeof currency !== "string") return "";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}

/** A calendar day (billing notices: due dates, the trial's end). */
export function formatDay(locale: Locale, iso: unknown, timeZone: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const zone = typeof timeZone === "string" && timeZone ? timeZone : "Europe/Stockholm";
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: zone }).format(
    new Date(iso),
  );
}

export function formatWhen(locale: Locale, iso: unknown, timeZone: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const zone = typeof timeZone === "string" && timeZone ? timeZone : "Europe/Stockholm";
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  }).format(new Date(iso));
}

/** Where a notice leads: the activity, series, event, club page or family page. */
export function noticeLink(input: NoticeInput): string {
  const id = input.subjectId;
  switch (input.subjectType) {
    case "activity":
      return id ? `/activities/${id}` : "/schedule";
    case "series":
      return id ? `/activity-series/${id}` : "/schedule";
    case "event":
      return id ? `/events/${id}` : "/schedule";
    case "member_export":
      return input.clubId ? `/clubs/${input.clubId}/members/exports` : "/";
    case "member_import":
      return input.clubId && id ? `/clubs/${input.clubId}/members/import?import=${id}` : "/";
    case "club":
      return input.clubId ? `/clubs/${input.clubId}` : "/";
    // Privacy (P1.8a): the register of the club a member left, the club's privacy page.
    case "club_membership":
      return input.clubId ? `/clubs/${input.clubId}/members` : "/";
    case "club_privacy_policy":
      return input.clubId ? `/clubs/${input.clubId}/privacy` : "/";
    case "club_creation_request": {
      const created = str(input.params.createdClubId);
      return created ? `/clubs/${created}` : "/";
    }
    // Privacy (P1.8b): the page with the person's exports and deletion.
    case "data_export":
    case "erasure_request":
      return "/me/privacy";
    case "guardianship":
      return "/me/family";
    // Protected identity (P1.12): the club's protected members, the family page.
    case "club_protected":
      return input.clubId ? `/clubs/${input.clubId}/protected` : "/";
    // Waiting lists (P1.10a): the applicant's waiting-list page.
    case "group_waitlist_entry":
      return "/me/waitlists";
    case "account":
      return "/me";
    // Billing (P1.13): the club's billing page (an invoice opened when given).
    case "club_billing":
      return input.clubId
        ? `/clubs/${input.clubId}/billing${id ? `?invoice=${id}` : ""}`
        : "/";
    // Calendar subscriptions (P1.11): the person's subscriptions page.
    case "calendar_feed":
      return "/me/calendar";
    default:
      return "/";
  }
}

/**
 * Title and body of a notice in a locale, from `notify.<type>` (`title`,
 * `body`). No person's name is ever part of them, so they are safe for push
 * and lock screens; the people a notice is about are shown separately.
 */
export function renderNotice(locale: Locale, input: NoticeInput): NoticeText {
  const p = input.params;
  const values: Record<string, string> = {
    club: input.clubName ?? "ClubAdmin",
    title: str(p.title),
    group: str(p.group),
    when: formatWhen(locale, p.startsAt, p.timeZone),
    previousWhen: formatWhen(locale, p.previousStartsAt, p.timeZone),
    deadline: formatWhen(locale, p.deadline, p.timeZone),
    scheduledFor: formatWhen(locale, p.scheduledFor, p.timeZone),
    place: str(p.place),
    hasPlace: p.place ? "yes" : "no",
    status: str(p.status),
    change: str(p.change),
    kind: str(p.kind),
    count: str(p.count ?? ""),
    imported: str(p.imported ?? ""),
    reason: "",
    /** A waiting-list closed reason: a code (P1.10a), never free text. */
    closedReason: str(p.closedReason),
    /** Why a calendar subscription was revoked (P1.11): a code. */
    feedReason: str(p.feedReason),
    /** Billing (P1.13): an invoice's number, amount and a date (due, trial end, read-only). */
    number: str(p.number),
    amount: formatAmount(locale, p.amountMinor, p.currency),
    date: formatDay(locale, p.date, p.timeZone),
    level: str(p.level ?? ""),
  };
  const key = isNotificationType(input.type) ? input.type : "unknown";
  const title =
    message(locale, `notify.${key}.title`, values) ||
    message(locale, "notify.unknown.title", values);
  const body = message(locale, `notify.${key}.body`, values);
  return { title, body, link: noticeLink(input) };
}

/** The generic text when lock-screen details are off. */
export const genericPush = (locale: Locale) => ({
  title: message(locale, "notify.generic.title", {}),
  body: message(locale, "notify.generic.body", {}),
});
