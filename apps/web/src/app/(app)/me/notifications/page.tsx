// SPDX-License-Identifier: AGPL-3.0-only
// The inbox (P1.7): my notifications, newest first. Opening one marks it
// read and goes where it leads; "Mark all as read" marks everything up to
// the newest. Texts come rendered from the API; the people a notice is about
// come through the API's presenter (hidden people are left out).

import { personLabel } from "@clubadmin/ui";
import { formatDateTime } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm } from "../../../../components/action-form.tsx";
import { FormError } from "../../../../components/form-error.tsx";
import { getNotifications } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("notifications.title") };
}

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

export default async function NotificationsPage({ searchParams }: Props) {
  const query = await searchParams;
  const unread = one(query.unread) === "true";
  const cursor = one(query.cursor);
  const [t, locale, timeZone, page] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    getNotifications(cursor, unread),
  ]);
  const newestUnread = cursor ? null : page.items.find((n) => n.readAt === null);
  const here = `/me/notifications${unread ? "?unread=true" : ""}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{t("notifications.title")}</h1>
        <a href="/me/notifications/settings" className="ml-auto text-sm underline">
          {t("notifications.settingsLink")}
        </a>
      </div>
      <FormError code={query.error} />
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label={t("notifications.filter")} className="flex gap-1 text-sm">
          <a
            href="/me/notifications"
            aria-current={unread ? undefined : "page"}
            className="rounded-md px-3 py-1 aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold"
          >
            {t("notifications.all")}
          </a>
          <a
            href="/me/notifications?unread=true"
            aria-current={unread ? "page" : undefined}
            data-testid="notifications-unread-filter"
            className="rounded-md px-3 py-1 aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold"
          >
            {t("notifications.unread")}
          </a>
        </nav>
        {newestUnread ? (
          <ActionForm action="read-notifications" back={here} className="ml-auto">
            <input type="hidden" name="before" value={page.items[0]!.id} />
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-1 text-sm"
              data-testid="notifications-mark-all"
            >
              {t("notifications.markAll")}
            </button>
          </ActionForm>
        ) : null}
      </div>
      {page.items.length === 0 ? (
        <p className="text-muted" data-testid="notifications-empty">
          {unread ? t("notifications.noneUnread") : t("notifications.empty")}
        </p>
      ) : (
        <ul
          data-testid="notifications"
          className="divide-y divide-border rounded-lg border border-border bg-raised"
        >
          {page.items.map((n) => (
            <li key={n.id} data-notification-id={n.id} data-unread={n.readAt === null}>
              <ActionForm action="read-notifications" back={here}>
                <input type="hidden" name="id" value={n.id} />
                <input type="hidden" name="to" value={n.link} />
                <button
                  type="submit"
                  className="block w-full px-4 py-3 text-left hover:bg-accent-soft"
                >
                  <span className="flex items-baseline gap-2">
                    {n.readAt === null ? (
                      <span className="sr-only">{t("notifications.unreadMark")}</span>
                    ) : null}
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${n.readAt === null ? "bg-accent" : "bg-transparent"}`}
                    />
                    <span className={n.readAt === null ? "font-semibold" : ""}>{n.title}</span>
                  </span>
                  {n.body ? <span className="mt-1 block text-sm">{n.body}</span> : null}
                  <span className="mt-1 block text-xs text-muted">
                    {[
                      n.about.length > 0 ? n.about.map((p) => personLabel(p)).join(", ") : null,
                      n.club?.name ?? null,
                      formatDateTime(n.createdAt, { locale, timeZone }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <a
          href={`/me/notifications?cursor=${page.nextCursor}${unread ? "&unread=true" : ""}`}
          className="inline-block text-sm underline"
          data-testid="notifications-more"
        >
          {t("notifications.older")}
        </a>
      ) : null}
    </div>
  );
}
