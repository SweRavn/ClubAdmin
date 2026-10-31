// SPDX-License-Identifier: AGPL-3.0-only
// The notifications module (P1.7, ADR 0039): the logged-in person's inbox,
// their notification settings and push devices, and unsubscribe links. The
// worker creates the notices and sends them (apps/worker/src/notifications);
// this module only reads and changes the recipient's own rows. The inbox is
// always the logged-in person's, also when acting on behalf of a ward.

import { type ActorContext, audit, type Database } from "@clubadmin/db";
import {
  hashPushToken,
  sealPushToken,
  verifyUnsubscribeToken,
} from "@clubadmin/server-kit/notifications";
import {
  effectiveSettings,
  MANDATORY_EMAIL_CATEGORIES,
  type MarkNotificationsReadInput,
  MarkNotificationsReadSchema,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TYPES,
  type NotificationCategory,
  type NotificationListQuery,
  type NotificationSettings,
  type NotificationSettingsResponse,
  type NotificationTypeInfo,
  type RegisterPushDeviceInput,
  RegisterPushDeviceSchema,
  UNREAD_COUNT_CAP,
  type UpdateNotificationSettingsInput,
  UpdateNotificationSettingsSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import * as repo from "./notifications.repository.ts";

export const INBOX_PAGE_SIZE = 30;

/** Categories whose every notice is emailed whatever the settings say (account). */
export const EMAIL_ONLY_MANDATORY: readonly NotificationCategory[] = NOTIFICATION_CATEGORIES.filter(
  (category) => {
    const types = Object.values(NOTIFICATION_TYPES as Record<string, NotificationTypeInfo>).filter(
      (t) => t.category === category,
    );
    return types.length > 0 && types.every((t) => t.mandatoryEmail);
  },
);

/** Categories with notices today (reserved ones, such as waitlist for P1.10, are not shown). */
const USED_CATEGORIES = NOTIFICATION_CATEGORIES.filter((category) =>
  Object.values(NOTIFICATION_TYPES as Record<string, NotificationTypeInfo>).some(
    (t) => t.category === category,
  ),
);

export interface NotificationsOptions {
  /** NOTIFICATION_TOKEN_KEY: seals push tokens, verifies unsubscribe links. */
  tokenKey: string | undefined;
  /** A push provider is configured. */
  push: boolean;
  /** SMTP is configured (the worker sends email); the API cannot tell, so it is assumed. */
  email?: boolean;
}

export interface InboxPage {
  items: repo.NotificationRow[];
  nextCursor: string | null;
  locale: string | null;
  clubNames: Map<string, string>;
}

export class NotificationsService {
  private readonly db: Database;
  private readonly options: NotificationsOptions;

  constructor(db: Database, options: NotificationsOptions) {
    this.db = db;
    this.options = options;
  }

  /** The logged-in person's notices, newest first (keyset by ID). */
  inbox(context: ActorContext, query: NotificationListQuery): Promise<InboxPage> {
    return this.db.withActor(context, async (tx) => {
      const personId = actorPersonId(context);
      const rows = await repo.listNotifications(tx, personId, {
        cursor: query.cursor,
        unread: query.unread,
        category: query.category,
        limit: INBOX_PAGE_SIZE + 1,
      });
      const items = rows.slice(0, INBOX_PAGE_SIZE);
      const account = await repo.accountSettings(tx, personId);
      const clubIds = [...new Set(items.flatMap((n) => (n.clubId ? [n.clubId] : [])))];
      return {
        items,
        nextCursor: rows.length > INBOX_PAGE_SIZE ? items.at(-1)!.id : null,
        locale: account?.locale ?? null,
        // Names of clubs the notices came from, also clubs the person has left.
        clubNames: clubIds.length
          ? await this.db.withSystem("notifications:club-names", {}, (system) =>
              repo.clubNames(system, clubIds),
            )
          : new Map(),
      };
    });
  }

  unreadCount(context: ActorContext): Promise<number> {
    return this.db.withActor(context, (tx) =>
      repo.countUnread(tx, actorPersonId(context), UNREAD_COUNT_CAP),
    );
  }

  /** Marks notices read: by ID, or everything up to and including a notice. */
  markRead(context: ActorContext, input: MarkNotificationsReadInput): Promise<number> {
    return this.db.withActor(context, (tx) =>
      repo.markRead(tx, actorPersonId(context), parseInput(MarkNotificationsReadSchema, input)),
    );
  }

  getSettings(context: ActorContext): Promise<NotificationSettingsResponse> {
    return this.db.withActor(context, async (tx) => {
      const account = await repo.accountSettings(tx, actorPersonId(context));
      if (!account) throw new DomainError("not_found");
      return this.present(account.settings);
    });
  }

  updateSettings(
    context: ActorContext,
    input: UpdateNotificationSettingsInput,
  ): Promise<NotificationSettingsResponse> {
    return this.db.withActor(context, async (tx) => {
      const data = parseInput(UpdateNotificationSettingsSchema, input);
      const account = await repo.accountSettings(tx, actorPersonId(context));
      if (!account) throw new DomainError("not_found");
      for (const c of data.categories) {
        if (c.email !== "always" && EMAIL_ONLY_MANDATORY.includes(c.category)) {
          throw new DomainError("notification_mandatory");
        }
      }
      const current = effectiveSettings(account.settings);
      const stored = (account.settings ?? {}) as NotificationSettings;
      const categories = { ...stored.categories };
      const changed = new Set<string>();
      for (const c of data.categories) {
        const before = current.categories[c.category];
        if (before.email === c.email && before.push === c.push) continue;
        categories[c.category] = { email: c.email, push: c.push };
        changed.add(`categories.${c.category}`);
      }
      const sameQuiet =
        JSON.stringify(current.quietHours) === JSON.stringify(data.quietHours ?? null);
      if (!sameQuiet) changed.add("quietHours");
      if (current.pushPreview !== data.pushPreview) changed.add("pushPreview");
      if (changed.size === 0) return this.present(account.settings);
      const next: NotificationSettings = {
        categories,
        quietHours: data.quietHours,
        pushPreview: data.pushPreview,
      };
      await repo.saveSettings(tx, account.id, next);
      await audit.record(tx, {
        action: "account.notification_settings.updated",
        resourceType: "account",
        resourceId: account.id,
        changedFields: [...changed],
      });
      return this.present(next);
    });
  }

  listDevices(context: ActorContext): Promise<repo.DeviceRow[]> {
    return this.db.withActor(context, (tx) => repo.listDevices(tx));
  }

  /**
   * Registers this phone's push token on the caller's account. Called on
   * every start of the app: an already registered token is only touched.
   */
  registerDevice(context: ActorContext, input: RegisterPushDeviceInput): Promise<repo.DeviceRow> {
    const key = this.options.tokenKey;
    if (!this.options.push || !key) throw new DomainError("push_not_available");
    return this.db.withActor(context, async (tx) => {
      actorPersonId(context);
      const data = parseInput(RegisterPushDeviceSchema, input);
      const tokenHash = hashPushToken(data.token);
      const existing = await repo.ownDeviceByHash(tx, tokenHash);
      const device = await repo.claimDevice(tx, {
        tokenHash,
        tokenSealed: sealPushToken(key, data.token),
        platform: data.platform,
        appVariant: data.appVariant,
      });
      if (!existing || existing.disabledAt) {
        await audit.record(tx, {
          action: "push_device.registered",
          resourceType: "push_device",
          resourceId: device.id,
        });
      }
      return device;
    });
  }

  /** Removes a device (logging out of the app, or from the settings page). */
  removeDevice(context: ActorContext, deviceId: string): Promise<void> {
    return this.db.withActor(context, async (tx) => {
      actorPersonId(context);
      if (!(await repo.deleteDevice(tx, deviceId))) throw new DomainError("not_found");
      await audit.record(tx, {
        action: "push_device.removed",
        resourceType: "push_device",
        resourceId: deviceId,
      });
    });
  }

  /**
   * An unsubscribe link (no login): turns the category's email off. The
   * token is signed for the account and category; it never expires but
   * stops working when the key is rotated.
   */
  unsubscribe(token: string | undefined): Promise<NotificationCategory> {
    const key = this.options.tokenKey;
    const parsed = key && token ? verifyUnsubscribeToken(key, token) : null;
    if (!parsed) throw new DomainError("unsubscribe_token_invalid");
    if (EMAIL_ONLY_MANDATORY.includes(parsed.category)) {
      throw new DomainError("notification_mandatory");
    }
    return this.db.withSystem("notifications:unsubscribe", {}, async (tx) => {
      if (!(await repo.setCategoryEmailNever(tx, parsed.accountId, parsed.category))) {
        throw new DomainError("unsubscribe_token_invalid");
      }
      await audit.record(tx, {
        action: "notifications.unsubscribed",
        resourceType: "account",
        resourceId: parsed.accountId,
        changedFields: [`categories.${parsed.category}`],
      });
      return parsed.category;
    });
  }

  private present(stored: unknown): NotificationSettingsResponse {
    const settings = effectiveSettings(stored);
    return {
      categories: USED_CATEGORIES.map((category) => ({
        category,
        ...settings.categories[category],
        emailMandatory: MANDATORY_EMAIL_CATEGORIES.includes(category),
      })),
      quietHours: settings.quietHours,
      pushPreview: settings.pushPreview,
      channels: [
        ...(this.options.email === false ? [] : (["email"] as const)),
        ...(this.options.push && this.options.tokenKey ? (["push"] as const) : []),
      ],
    };
  }
}
