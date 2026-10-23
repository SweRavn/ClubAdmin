// SPDX-License-Identifier: AGPL-3.0-only
// An agenda: activities grouped by their local date (in each activity's club
// time zone), with time, title, kind, place, groups and, for "My schedule",
// whose schedule it is on. Cancelled activities stay, struck through, with
// the reason. Never lists participants (ADR 0021, 0022). "My schedule" has
// the answer buttons per person (P1.5); calendars of those who manage an
// activity show how many have answered.
import { enumKey } from "@clubadmin/i18n";
import { localDate, type PersonSummary } from "@clubadmin/shared";
import { formatDateTime, personLabel, RoleBadge } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ResponseButtons } from "./response-buttons.tsx";

export interface AgendaItem {
  id: string;
  href: string;
  title: string;
  kind: string;
  status: "scheduled" | "cancelled";
  cancelledReason: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone: string;
  place: string | null;
  groups: { id: string; name: string }[];
  people?: PersonSummary[];
  /** Changed since the viewer's last visit (My schedule). */
  changed?: boolean;
  /** Edited apart from its series (calendars of those who manage it). */
  detached?: boolean;
  /** Answers (P1.5): asked for, and the deadline. */
  responseMode?: string;
  respondBy?: string | null;
  /** My family's answers (My schedule); `label` when the viewer answers for several. */
  responses?: {
    personId: string;
    label: string | null;
    status: "attending" | "not_attending" | null;
    canRespond: boolean;
  }[];
  /** For those who manage it (group calendar). */
  counts?: { attending: number; notAttending: number; notAnswered: number };
}

export async function Agenda({
  items,
  emptyText,
  showPeople = false,
  testId = "agenda",
}: {
  items: readonly AgendaItem[];
  emptyText: string;
  showPeople?: boolean;
  testId?: string;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  if (items.length === 0) {
    return (
      <p className="text-muted" data-testid={`${testId}-empty`}>
        {emptyText}
      </p>
    );
  }
  const days: { key: string; label: string; items: AgendaItem[] }[] = [];
  for (const item of items) {
    const key = localDate(new Date(item.startsAt), item.timeZone);
    let day = days.at(-1);
    if (day?.key !== key) {
      day = {
        key,
        label: formatDateTime(item.startsAt, {
          locale,
          timeZone: item.timeZone,
          dateStyle: "full",
        }),
        items: [],
      };
      days.push(day);
    }
    day.items.push(item);
  }
  const time = (item: AgendaItem, value: string) =>
    formatDateTime(value, { locale, timeZone: item.timeZone, timeStyle: "short" });

  return (
    <ol className="space-y-5" data-testid={testId}>
      {days.map((day) => (
        <li key={day.key}>
          <h3 className="mb-2 text-sm font-semibold capitalize text-muted">{day.label}</h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-raised">
            {day.items.map((item) => {
              const cancelled = item.status === "cancelled";
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2"
                  data-testid="agenda-item"
                  data-status={item.status}
                >
                  <span className="w-28 shrink-0 tabular-nums text-sm">
                    {item.allDay
                      ? t("activities.allDay")
                      : `${time(item, item.startsAt)}–${time(item, item.endsAt)}`}
                  </span>
                  <span className="min-w-0 flex-1">
                    <a
                      href={item.href}
                      className={`font-medium text-accent underline-offset-2 hover:underline ${
                        cancelled ? "line-through" : ""
                      }`}
                    >
                      {item.title}
                    </a>{" "}
                    <RoleBadge label={t(enumKey("activityKinds", item.kind))} />
                    {cancelled ? (
                      <>
                        {" "}
                        <RoleBadge tone="accent" label={t("activities.cancelled")} />
                      </>
                    ) : null}
                    {item.changed ? (
                      <>
                        {" "}
                        <RoleBadge tone="accent" label={t("activities.changed")} />
                      </>
                    ) : null}
                    {item.detached ? (
                      <>
                        {" "}
                        <RoleBadge label={t("activities.detached")} />
                      </>
                    ) : null}
                    <span className="block text-sm text-muted">
                      {[item.place, item.groups.map((g) => g.name).join(", ")]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {cancelled && item.cancelledReason ? (
                      <span className="block text-sm">{item.cancelledReason}</span>
                    ) : null}
                    {item.counts ? (
                      <span className="block text-sm text-muted" data-testid="agenda-counts">
                        {t("responses.counts", item.counts)}
                      </span>
                    ) : null}
                    {!cancelled && item.responses?.some((r) => r.canRespond) ? (
                      <span className="mt-2 block space-y-2" data-testid="agenda-responses">
                        {item.responseMode === "requested" &&
                        item.responses.some((r) => r.canRespond && r.status === null) ? (
                          <RoleBadge tone="accent" label={t("responses.answerNeeded")} />
                        ) : null}
                        {item.respondBy ? (
                          <span className="block text-xs text-muted">
                            {t("responses.answerBy", {
                              time: formatDateTime(item.respondBy, {
                                locale,
                                timeZone: item.timeZone,
                                dateStyle: "medium",
                                timeStyle: "short",
                              }),
                            })}
                          </span>
                        ) : null}
                        {item.responses
                          .filter((r) => r.canRespond)
                          .map((r) => (
                            <ResponseButtons
                              key={r.personId}
                              activityId={item.id}
                              personId={r.personId}
                              status={r.status}
                              deadlinePassed={
                                item.respondBy ? Date.parse(item.respondBy) < Date.now() : false
                              }
                              {...(r.label ? { label: r.label } : {})}
                            />
                          ))}
                      </span>
                    ) : null}
                    {showPeople && item.people && item.people.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1" data-testid="agenda-people">
                        {item.people.map((p) => (
                          <span key={p.id} className="rounded-full bg-surface px-2 py-0.5 text-xs">
                            {personLabel(p)}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** An activity of a calendar (the API's Activity) as an agenda item. */
export function agendaItemOf(a: {
  id: string;
  title: string;
  kind: string;
  status: "scheduled" | "cancelled";
  cancelledReason: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone: string;
  location: { name: string } | null;
  locationText: string | null;
  groups: { id: string; name: string }[];
  detached: boolean;
  canManage: boolean;
  responseMode?: string | undefined;
  responseCounts?: { attending: number; notAttending: number; notAnswered: number } | undefined;
}): AgendaItem {
  return {
    id: a.id,
    href: `/activities/${a.id}`,
    title: a.title,
    kind: a.kind,
    status: a.status,
    cancelledReason: a.cancelledReason,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    allDay: a.allDay,
    timeZone: a.timeZone,
    place: a.location?.name ?? a.locationText,
    groups: a.groups,
    detached: a.canManage && a.detached,
    ...(a.responseCounts && a.status === "scheduled" ? { counts: a.responseCounts } : {}),
  };
}

/**
 * The range of `weeks` weeks shown at `offset` (0: from two hours ago, so
 * what is going on now stays; otherwise from Monday of that week, UTC with
 * a day of margin for the club's zone).
 */
export function weekRange(offset: number, weeks: number): { from: string; to: string } {
  const now = Date.now();
  const today = new Date(now);
  const monday =
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
    ((today.getUTCDay() || 7) - 1) * 86_400_000;
  const from = offset === 0 ? now - 2 * 3_600_000 : monday + offset * 7 * 86_400_000 - 86_400_000;
  const to = monday + (offset + weeks) * 7 * 86_400_000 + 86_400_000;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** `?week=` as a whole number of weeks from this one (-52 to 52). */
export function weekOffset(value: string | string[] | undefined): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : 0;
  return Number.isInteger(n) ? Math.max(-52, Math.min(52, n)) : 0;
}
