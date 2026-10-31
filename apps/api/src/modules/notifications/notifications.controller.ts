// SPDX-License-Identifier: AGPL-3.0-only
// The inbox, notification settings and push devices of the logged-in person
// (P1.7, ADR 0039), and the unsubscribe link of notification emails. A
// notice's title and body are rendered here in the account's language from
// its type and params, which never hold names; the people it is about go
// through the PersonPresenter (hidden people are left out).

import { localeOf, negotiateLocale } from "@clubadmin/i18n";
import { renderNotice } from "@clubadmin/server-kit/notifications";
import {
  type MarkNotificationsReadInput,
  MarkNotificationsReadSchema,
  type NotificationItem,
  type NotificationList,
  type NotificationListQuery,
  NotificationListQuerySchema,
  NotificationListSchema,
  type NotificationSettingsResponse,
  NotificationSettingsResponseSchema,
  type PersonSummary,
  PushDeviceListSchema,
  PushDeviceParamsSchema,
  PushDeviceSchema,
  type RegisterPushDeviceInput,
  RegisterPushDeviceSchema,
  UnreadCountSchema,
  type UnsubscribeInput,
  UnsubscribeQuerySchema,
  UnsubscribeResultSchema,
  UnsubscribeSchema,
  type UpdateNotificationSettingsInput,
  UpdateNotificationSettingsSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import type { DeviceRow } from "./notifications.repository.ts";
import { NotificationsService } from "./notifications.service.ts";

/** Unsubscribe links: per client IP, on top of the global limit. */
const UNSUBSCRIBE_LIMIT = { max: 20, timeWindowMs: 60_000 };

const toDevice = (d: DeviceRow) => ({
  id: d.id,
  platform: d.platform as "ios" | "android",
  appVariant: d.appVariant,
  lastSeenAt: d.lastSeenAt.toISOString(),
});

@Controller("me")
export class NotificationsController {
  private readonly notifications: NotificationsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(
    notifications: NotificationsService,
    people: PeopleService,
    presenter: PersonPresenter,
  ) {
    this.notifications = notifications;
    this.people = people;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: "notifications",
    summary: "My notifications, newest first",
    tags: ["notifications"],
    access: { authenticated: true },
    request: { query: NotificationListQuerySchema },
    response: NotificationListSchema,
  })
  async inbox(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: NotificationListQuery,
    @Req() request: FastifyRequest,
  ): Promise<NotificationList> {
    const page = await this.notifications.inbox(authz.context, query);
    // As in emails: the account's language, else the club's, else the browser's.
    const fallback = negotiateLocale(request.headers["accept-language"]);
    const about = await this.about(authz, page.items);
    return {
      items: page.items.map((n): NotificationItem => {
        const club = n.clubId ? page.clubs.get(n.clubId) : undefined;
        const clubName = club?.name ?? null;
        const locale = localeOf(page.locale) ?? localeOf(club?.defaultLocale) ?? fallback;
        const text = renderNotice(locale, {
          type: n.type,
          clubId: n.clubId,
          clubName,
          subjectType: n.subjectType,
          subjectId: n.subjectId,
          params: n.params,
        });
        return {
          id: n.id,
          type: n.type,
          category: n.category,
          club: n.clubId && clubName ? { id: n.clubId, name: clubName } : null,
          link: text.link,
          about: n.aboutPersonIds.flatMap((id) => {
            const person = about.get(`${n.clubId ?? ""}|${id}`);
            return person ? [person] : [];
          }),
          title: text.title,
          body: text.body,
          createdAt: n.createdAt.toISOString(),
          readAt: n.readAt ? n.readAt.toISOString() : null,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "GET",
    path: "notifications/unread-count",
    summary: "How many of my notifications are unread (at most 100)",
    tags: ["notifications"],
    access: { authenticated: true },
    response: UnreadCountSchema,
  })
  async unreadCount(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<{ count: number }> {
    return { count: await this.notifications.unreadCount(authz.context) };
  }

  @Endpoint({
    method: "POST",
    path: "notifications/read",
    summary: "Mark notifications read (by ID, or all up to one); returns the unread count",
    tags: ["notifications"],
    access: { authenticated: true },
    request: { body: MarkNotificationsReadSchema },
    response: UnreadCountSchema,
    status: 200,
  })
  async markRead(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: MarkNotificationsReadInput,
  ): Promise<{ count: number }> {
    await this.notifications.markRead(authz.context, body);
    return { count: await this.notifications.unreadCount(authz.context) };
  }

  @Endpoint({
    method: "GET",
    path: "notification-settings",
    summary: "My notification settings per category, quiet hours and lock-screen details",
    tags: ["notifications"],
    access: { authenticated: true },
    response: NotificationSettingsResponseSchema,
  })
  settings(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<NotificationSettingsResponse> {
    return this.notifications.getSettings(authz.context);
  }

  @Endpoint({
    method: "PUT",
    path: "notification-settings",
    summary: "Change my notification settings",
    tags: ["notifications"],
    access: { authenticated: true },
    request: { body: UpdateNotificationSettingsSchema },
    response: NotificationSettingsResponseSchema,
  })
  updateSettings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: UpdateNotificationSettingsInput,
  ): Promise<NotificationSettingsResponse> {
    return this.notifications.updateSettings(authz.context, body);
  }

  @Endpoint({
    method: "GET",
    path: "push-devices",
    summary: "Phones that get my push notifications",
    tags: ["notifications"],
    access: { authenticated: true },
    response: PushDeviceListSchema,
  })
  async devices(@CurrentAuthorization() authz: RequestAuthorization) {
    return { items: (await this.notifications.listDevices(authz.context)).map(toDevice) };
  }

  @Endpoint({
    method: "PUT",
    path: "push-devices",
    summary: "Register this phone for push notifications (idempotent per token)",
    tags: ["notifications"],
    access: { authenticated: true },
    request: { body: RegisterPushDeviceSchema },
    response: PushDeviceSchema,
  })
  async registerDevice(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: RegisterPushDeviceInput,
  ) {
    return toDevice(await this.notifications.registerDevice(authz.context, body));
  }

  @Endpoint({
    method: "DELETE",
    path: "push-devices/:deviceId",
    summary: "Stop push notifications to a phone (logging out of the app)",
    tags: ["notifications"],
    access: { authenticated: true },
    request: { params: PushDeviceParamsSchema },
    response: z.null(),
    status: 204,
  })
  async removeDevice(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof PushDeviceParamsSchema>,
  ): Promise<null> {
    await this.notifications.removeDevice(authz.context, params.deviceId);
    return null;
  }

  /** People the notices are about, as the viewer may see them, keyed by "<clubId>|<personId>". */
  private async about(
    authz: RequestAuthorization,
    items: readonly { clubId: string | null; aboutPersonIds: string[] }[],
  ): Promise<Map<string, PersonSummary>> {
    const byClub = new Map<string | null, Set<string>>();
    for (const n of items) {
      if (n.aboutPersonIds.length === 0) continue;
      const set = byClub.get(n.clubId) ?? new Set<string>();
      for (const id of n.aboutPersonIds) set.add(id);
      byClub.set(n.clubId, set);
    }
    const all = [...new Set([...byClub.values()].flatMap((s) => [...s]))];
    if (all.length === 0) return new Map();
    const rows = new Map((await this.people.summaries(authz.context, all)).map((p) => [p.id, p]));
    const result = new Map<string, PersonSummary>();
    // One presenter call per club on the page (a handful), never per notice.
    for (const [clubId, ids] of byClub) {
      const people = [...ids].flatMap((id) => {
        const row = rows.get(id);
        return row ? [row] : [];
      });
      for (const p of await this.presenter.present(authz, clubId, people)) {
        result.set(`${clubId ?? ""}|${p.id}`, p);
      }
    }
    return result;
  }
}

@Controller("notifications")
export class UnsubscribeController {
  private readonly notifications: NotificationsService;

  constructor(notifications: NotificationsService) {
    this.notifications = notifications;
  }

  @Endpoint({
    method: "POST",
    path: "unsubscribe",
    summary: "Turn off email for a category from an email's unsubscribe link (one-click, RFC 8058)",
    tags: ["notifications"],
    access: { public: true },
    request: { query: UnsubscribeQuerySchema, body: UnsubscribeSchema },
    response: UnsubscribeResultSchema,
    status: 200,
    rateLimit: UNSUBSCRIBE_LIMIT,
  })
  async unsubscribe(
    @Query() query: z.infer<typeof UnsubscribeQuerySchema>,
    @Body() body: UnsubscribeInput | undefined,
  ) {
    return { category: await this.notifications.unsubscribe(body?.token ?? query.token) };
  }
}
