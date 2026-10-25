// SPDX-License-Identifier: AGPL-3.0-only
// A list of events (P1.6): open for sign-up first, with "Full", "Waiting
// list" and "Closes …" badges, then the others by start.
import type { Event } from "@clubadmin/shared";
import { EmptyState } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ClubTime } from "./club-time.tsx";

const badge = "rounded-full border border-border px-2 py-0.5 text-xs";

export async function EventList({ events, testId }: { events: readonly Event[]; testId?: string }) {
  const t = await getTranslations();
  if (events.length === 0) return <EmptyState title={t("events.empty")} headingLevel={3} />;
  const sorted = [...events].sort(
    (a, b) => Number(b.open) - Number(a.open) || a.startsAt.localeCompare(b.startsAt),
  );
  return (
    <ul
      className="divide-y divide-border rounded-lg border border-border bg-raised"
      data-testid={testId}
    >
      {sorted.map((e) => {
        const full = e.counts.placesLeft === 0;
        return (
          <li key={e.id} className="space-y-1 px-3 py-2" data-testid="event-item">
            <a href={`/events/${e.id}`} className="font-medium underline">
              {e.title}
            </a>
            <p className="text-sm text-muted">
              <ClubTime value={e.startsAt} timeZone={e.timeZone} dateStyle="medium" />
              {e.groups.length > 0 ? ` · ${e.groups.map((g) => g.name).join(", ")}` : ""}
            </p>
            <p className="flex flex-wrap gap-1">
              {e.status === "draft" ? <span className={badge}>{t("events.draft")}</span> : null}
              {e.status === "cancelled" ? (
                <span className={badge}>{t("events.cancelled")}</span>
              ) : null}
              {e.open && full ? (
                <span className={badge}>
                  {e.waitlistMode === "none" ? t("events.full") : t("events.waitingList")}
                </span>
              ) : null}
              {e.open ? (
                <span className={badge}>
                  {t("events.closes")}{" "}
                  <ClubTime
                    value={e.registrationClosesAt}
                    timeZone={e.timeZone}
                    dateStyle="medium"
                    timeStyle="short"
                  />
                </span>
              ) : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
