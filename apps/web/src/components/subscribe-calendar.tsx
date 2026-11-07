// SPDX-License-Identifier: AGPL-3.0-only
// "Subscribe to this calendar" on a group's calendar and the club calendar
// (P1.11): creates the feed (app/actions/calendar-feed) and shows its URL once
// on /me/calendar. Works without client JavaScript.
import { getTranslations } from "next-intl/server";

import { requireSession } from "../server/data.ts";
import { secondaryButtonClass } from "./action-form.tsx";

export async function SubscribeCalendar({
  target,
  targetId,
}: {
  target: "group" | "club";
  targetId: string;
}) {
  const [t, session] = await Promise.all([getTranslations(), requireSession()]);
  return (
    <form method="post" action="/actions/calendar-feed" data-testid="subscribe-calendar">
      <input type="hidden" name="csrf" value={session.record.csrf} />
      <input type="hidden" name="target" value={target} />
      <input type="hidden" name="targetId" value={targetId} />
      <button type="submit" className={secondaryButtonClass}>
        {t("calendar.ui.subscribeThis")}
      </button>
    </form>
  );
}
