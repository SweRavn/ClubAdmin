// SPDX-License-Identifier: AGPL-3.0-only
// Notifications (P1.7): the catalogue of notification types with their
// category and default channels, the recipient's settings, and the API's
// request and response schemas. Clients ignore types and categories they do
// not know (ADR 0029) and show a generic entry.

import { PersonSummarySchema } from "./auth/schemas.ts";
import { z } from "./zod.ts";

export const NOTIFICATION_CATEGORIES = [
  "schedule",
  "responses",
  "leader",
  "events",
  "membership",
  "club_admin",
  "family",
  "account",
  "waitlist",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Email per category: always (in the daily email), only without the app, or never. */
export const EMAIL_MODES = ["always", "no_app", "never"] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

export const NOTIFICATION_CHANNELS = ["email", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface CategoryDefaults {
  email: EmailMode;
  push: boolean;
}

/** Defaults per category; missing settings mean these, so they can change later. */
export const CATEGORY_DEFAULTS: Record<NotificationCategory, CategoryDefaults> = {
  schedule: { email: "no_app", push: true },
  responses: { email: "no_app", push: true },
  leader: { email: "never", push: true },
  events: { email: "no_app", push: true },
  membership: { email: "always", push: true },
  club_admin: { email: "always", push: false },
  family: { email: "always", push: false },
  account: { email: "always", push: false },
  waitlist: { email: "no_app", push: true },
};

export interface NotificationTypeInfo {
  category: NotificationCategory;
  /** The email cannot be turned off (it is sent whatever the settings say). */
  mandatoryEmail?: true;
  /** Emailed at once instead of in the daily email. */
  immediate?: true;
}

export const NOTIFICATION_TYPES = {
  "activity.cancelled": { category: "schedule" },
  "activity.restored": { category: "schedule" },
  "activity.moved": { category: "schedule" },
  "activity.added": { category: "schedule" },
  "series.changed": { category: "schedule" },
  "callup.added": { category: "schedule" },
  "callup.removed": { category: "schedule" },
  "response.reminder": { category: "responses" },
  "response.late_decline": { category: "leader" },
  "event.published": { category: "events" },
  "event.cancelled": { category: "events" },
  "event.registration.confirmed": { category: "events" },
  "event.registration.waitlisted": { category: "events" },
  "event.registration.removed": { category: "events" },
  "event.offer.offered": { category: "events", immediate: true },
  "event.offer.confirmed": { category: "events" },
  "event.signup.reminder": { category: "events" },
  "join_request.decided": { category: "membership" },
  "club_creation.decided": { category: "membership" },
  "club.managers.changed": { category: "club_admin", mandatoryEmail: true, immediate: true },
  "members.exported": { category: "club_admin", mandatoryEmail: true, immediate: true },
  "members.import.finished": { category: "club_admin", immediate: true },
  "family.accepted": { category: "family" },
  "family.own_login_age": { category: "family" },
  "family.adult": { category: "family" },
  "family.adult_ended": { category: "family" },
  "account.email.changed": { category: "account", mandatoryEmail: true, immediate: true },
} as const satisfies Record<string, NotificationTypeInfo>;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_NAMES = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

export const isNotificationType = (value: string): value is NotificationType =>
  Object.hasOwn(NOTIFICATION_TYPES, value);

export function notificationTypeInfo(type: NotificationType): NotificationTypeInfo {
  return NOTIFICATION_TYPES[type];
}

/** Categories with a type whose email cannot be turned off. */
export const MANDATORY_EMAIL_CATEGORIES: readonly NotificationCategory[] = [
  ...new Set(
    Object.values(NOTIFICATION_TYPES as Record<string, NotificationTypeInfo>)
      .filter((t) => t.mandatoryEmail)
      .map((t) => t.category),
  ),
];

/** The daily email goes out at this local time (decision 16, not a setting). */
export const DIGEST_LOCAL_TIME = "17:00";
/** Every notice reaches the person at least this long before what it is about (decision 17). */
export const NOTICE_LEAD_HOURS = 24;
/** Changes, cancellations and moves of activities further ahead are not news yet. */
export const NOTICE_HORIZON_DAYS = 14;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** `accounts.notification_settings`: missing keys mean the defaults, so `{}` is valid. */
export const NotificationSettingsSchema = z
  .object({
    categories: z
      .partialRecord(
        z.enum(NOTIFICATION_CATEGORIES),
        z.object({ email: z.enum(EMAIL_MODES), push: z.boolean() }).partial(),
      )
      .optional(),
    /** Push is held during these hours (recipient's time zone); null: off. */
    quietHours: z.object({ from: clock, to: clock }).nullable().optional(),
    /** Off: push notifications say only "New notification from ClubAdmin". */
    pushPreview: z.boolean().optional(),
  })
  .openapi("NotificationSettings");
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const DEFAULT_QUIET_HOURS = { from: "21:00", to: "07:00" } as const;

export interface EffectiveSettings {
  categories: Record<NotificationCategory, CategoryDefaults>;
  quietHours: { from: string; to: string } | null;
  pushPreview: boolean;
}

/** The settings with the defaults filled in; mandatory email categories keep email on. */
export function effectiveSettings(stored: unknown): EffectiveSettings {
  const parsed = NotificationSettingsSchema.safeParse(stored ?? {});
  const settings: NotificationSettings = parsed.success ? parsed.data : {};
  const categories = Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [
      category,
      { ...CATEGORY_DEFAULTS[category], ...settings.categories?.[category] },
    ]),
  ) as Record<NotificationCategory, CategoryDefaults>;
  return {
    categories,
    quietHours: settings.quietHours === undefined ? DEFAULT_QUIET_HOURS : settings.quietHours,
    pushPreview: settings.pushPreview ?? true,
  };
}

// --- API ---------------------------------------------------------------------------

export const NotificationSchema = z
  .object({
    id: z.uuid(),
    type: z.string(),
    category: z.string(),
    club: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    /** Where the notice leads in the apps (a path with IDs only). */
    link: z.string(),
    /** The people it is about (wards, a player); hidden people are left out. */
    about: z.array(PersonSummarySchema),
    title: z.string(),
    body: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    readAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .openapi("Notification");
export type NotificationItem = z.infer<typeof NotificationSchema>;

export const NotificationListQuerySchema = z.object({
  cursor: z.uuid().optional(),
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export const NotificationListSchema = z
  .object({ items: z.array(NotificationSchema), nextCursor: z.uuid().nullable() })
  .openapi("NotificationList");
export type NotificationList = z.infer<typeof NotificationListSchema>;

/** At most this many are counted (the badge shows "99+"). */
export const UNREAD_COUNT_CAP = 100;

export const UnreadCountSchema = z
  .object({ count: z.number().int().min(0).max(UNREAD_COUNT_CAP) })
  .openapi("UnreadNotificationCount");

export const MarkNotificationsReadSchema = z
  .union([
    z.object({ ids: z.array(z.uuid()).min(1).max(100) }).strict(),
    z.object({ before: z.uuid() }).strict(),
  ])
  .openapi("MarkNotificationsRead");
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadSchema>;

export const NotificationSettingsResponseSchema = z
  .object({
    categories: z.array(
      z.object({
        category: z.enum(NOTIFICATION_CATEGORIES),
        email: z.enum(EMAIL_MODES),
        push: z.boolean(),
        /** The email cannot be turned off for some of its notices. */
        emailMandatory: z.boolean(),
      }),
    ),
    quietHours: z.object({ from: clock, to: clock }).nullable(),
    pushPreview: z.boolean(),
    /** Channels this server has (push only with a push provider). */
    channels: z.array(z.enum(NOTIFICATION_CHANNELS)),
  })
  .openapi("NotificationSettingsResponse");
export type NotificationSettingsResponse = z.infer<typeof NotificationSettingsResponseSchema>;

export const UpdateNotificationSettingsSchema = z
  .object({
    categories: z.array(
      z.object({
        category: z.enum(NOTIFICATION_CATEGORIES),
        email: z.enum(EMAIL_MODES),
        push: z.boolean(),
      }),
    ),
    quietHours: z.object({ from: clock, to: clock }).nullable(),
    pushPreview: z.boolean(),
  })
  .strict()
  .openapi("UpdateNotificationSettings");
export type UpdateNotificationSettingsInput = z.infer<typeof UpdateNotificationSettingsSchema>;

export const PUSH_PLATFORMS = ["ios", "android"] as const;

export const RegisterPushDeviceSchema = z
  .object({
    /** The Expo push token ("ExponentPushToken[…]"). */
    token: z.string().min(10).max(200),
    platform: z.enum(PUSH_PLATFORMS),
    appVariant: z.string().max(40).default("production"),
  })
  .strict()
  .openapi("RegisterPushDevice");
export type RegisterPushDeviceInput = z.input<typeof RegisterPushDeviceSchema>;

export const PushDeviceSchema = z
  .object({
    id: z.uuid(),
    platform: z.enum(PUSH_PLATFORMS),
    appVariant: z.string(),
    lastSeenAt: z.iso.datetime({ offset: true }),
  })
  .openapi("PushDevice");

export const PushDeviceListSchema = z
  .object({ items: z.array(PushDeviceSchema) })
  .openapi("PushDeviceList");

const unsubscribeTokenSchema = z.string().min(20).max(300);

/**
 * The unsubscribe page posts the token as JSON; mail clients' one-click
 * unsubscribe (RFC 8058) posts "List-Unsubscribe=One-Click" as a form with
 * the token in the query.
 */
export const UnsubscribeSchema = z
  .object({
    token: unsubscribeTokenSchema.optional(),
    "List-Unsubscribe": z.literal("One-Click").optional(),
  })
  .strict()
  .openapi("Unsubscribe");
export type UnsubscribeInput = z.infer<typeof UnsubscribeSchema>;

export const UnsubscribeQuerySchema = z.object({ token: unsubscribeTokenSchema.optional() });

export const UnsubscribeResultSchema = z
  .object({ category: z.enum(NOTIFICATION_CATEGORIES) })
  .openapi("UnsubscribeResult");

export const PushDeviceParamsSchema = z.object({ deviceId: z.uuid() });
