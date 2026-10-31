// SPDX-License-Identifier: AGPL-3.0-only
// Tables of the notifications module (P1.7, ADR 0039): notices of the
// logged-in person, their account's settings and push devices. Row-level
// security limits every statement to the caller's own rows.

import { and, desc, eq, inArray, isNull, lt, lte, schema, sql, type Tx } from "@clubadmin/db";
import type { NotificationCategory } from "@clubadmin/shared";

const { notifications, pushDevices, accounts, clubs } = schema;

export type NotificationRow = Pick<
  typeof notifications.$inferSelect,
  | "id"
  | "clubId"
  | "category"
  | "type"
  | "subjectType"
  | "subjectId"
  | "aboutPersonIds"
  | "params"
  | "createdAt"
  | "readAt"
>;

export async function listNotifications(
  tx: Tx,
  personId: string,
  options: {
    cursor?: string | undefined;
    unread: boolean;
    category?: NotificationCategory | undefined;
    limit: number;
  },
): Promise<NotificationRow[]> {
  return tx
    .select({
      id: notifications.id,
      clubId: notifications.clubId,
      category: notifications.category,
      type: notifications.type,
      subjectType: notifications.subjectType,
      subjectId: notifications.subjectId,
      aboutPersonIds: notifications.aboutPersonIds,
      params: notifications.params,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientPersonId, personId),
        options.cursor ? lt(notifications.id, options.cursor) : undefined,
        options.unread ? isNull(notifications.readAt) : undefined,
        options.category ? eq(notifications.category, options.category) : undefined,
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(options.limit);
}

/** Unread notices, counted up to `cap` (the partial index stops there). */
export async function countUnread(tx: Tx, personId: string, cap: number): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM public.notifications
      WHERE recipient_person_id = ${personId} AND read_at IS NULL LIMIT ${cap}) u`);
  return rows[0]?.n ?? 0;
}

export async function markRead(
  tx: Tx,
  personId: string,
  target: { ids: readonly string[] } | { before: string },
): Promise<number> {
  const rows = await tx
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.recipientPersonId, personId),
        isNull(notifications.readAt),
        "ids" in target
          ? inArray(notifications.id, [...target.ids])
          : lte(notifications.id, target.before),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}

export interface ClubLabel {
  name: string;
  defaultLocale: string;
}

/** Names and languages of the clubs notices came from (also clubs the person has left since). */
export async function clubLabels(
  tx: Tx,
  clubIds: readonly string[],
): Promise<Map<string, ClubLabel>> {
  if (clubIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: clubs.id, name: clubs.name, defaultLocale: clubs.defaultLocale })
    .from(clubs)
    .where(inArray(clubs.id, [...clubIds]));
  return new Map(rows.map((r) => [r.id, { name: r.name, defaultLocale: r.defaultLocale }]));
}

export type SettingsRow = { id: string; locale: string | null; settings: unknown };

export async function accountSettings(tx: Tx, personId: string): Promise<SettingsRow | null> {
  const [row] = await tx
    .select({
      id: accounts.id,
      locale: accounts.locale,
      settings: accounts.notificationSettings,
    })
    .from(accounts)
    .where(eq(accounts.personId, personId));
  return row ?? null;
}

export async function saveSettings(
  tx: Tx,
  accountId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(accounts)
    .set({ notificationSettings: settings })
    .where(eq(accounts.id, accountId));
}

export type DeviceRow = Pick<
  typeof pushDevices.$inferSelect,
  "id" | "platform" | "appVariant" | "lastSeenAt" | "disabledAt"
>;

const deviceColumns = {
  id: pushDevices.id,
  platform: pushDevices.platform,
  appVariant: pushDevices.appVariant,
  lastSeenAt: pushDevices.lastSeenAt,
  disabledAt: pushDevices.disabledAt,
};

export async function listDevices(tx: Tx): Promise<DeviceRow[]> {
  return tx
    .select(deviceColumns)
    .from(pushDevices)
    .where(isNull(pushDevices.disabledAt))
    .orderBy(desc(pushDevices.lastSeenAt));
}

/** The caller's device with this token, if any (other accounts' rows are not visible). */
export async function ownDeviceByHash(tx: Tx, tokenHash: string): Promise<DeviceRow | null> {
  const [row] = await tx
    .select(deviceColumns)
    .from(pushDevices)
    .where(eq(pushDevices.tokenHash, tokenHash));
  return row ?? null;
}

/** Registers the token on the caller's account (moving it from another account). */
export async function claimDevice(
  tx: Tx,
  values: { tokenHash: string; tokenSealed: string; platform: string; appVariant: string },
): Promise<DeviceRow> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT app.claim_push_device(${values.tokenHash}, ${values.tokenSealed},
      ${values.platform}, ${values.appVariant}) AS id`);
  const [row] = await tx
    .select(deviceColumns)
    .from(pushDevices)
    .where(eq(pushDevices.id, rows[0]!.id));
  return row!;
}

export async function deleteDevice(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .delete(pushDevices)
    .where(eq(pushDevices.id, id))
    .returning({ id: pushDevices.id });
  return rows.length > 0;
}

/** Turns a category's email off (unsubscribe link; system context). Returns whether the account exists. */
export async function setCategoryEmailNever(
  tx: Tx,
  accountId: string,
  category: NotificationCategory,
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE public.accounts
    SET notification_settings = jsonb_set(
      jsonb_set(notification_settings, '{categories}',
        coalesce(notification_settings -> 'categories', '{}'::jsonb)),
      ARRAY['categories', ${category}],
      coalesce(notification_settings -> 'categories' -> ${category}, '{}'::jsonb)
        || '{"email": "never"}'::jsonb)
    WHERE id = ${accountId}
    RETURNING id`);
  return rows.length > 0;
}
