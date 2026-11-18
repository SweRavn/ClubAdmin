// SPDX-License-Identifier: AGPL-3.0-only
// "Mina uppgifter" (P2.4, ADR 0052): the action items given to the viewer
// and their children across clubs, open ones by due date or the done ones;
// the assignee marks them done (or not done after all). Duty shifts (P2.6)
// are marked by their planners; their holders offer them to someone else,
// and the family's quotas, open shifts and swaps in a club are below.
import { enumKey } from "@clubadmin/i18n";
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, secondaryButtonClass } from "../../../../components/action-form.tsx";
import { type Family, MyDutiesSection } from "../../../../components/duties.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { getMe, getMyClubs, getMyDuties, getMyTasks, getMyWards } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("tasks.title") };
}

export default async function MyTasksPage({ searchParams }: Props) {
  const query = await searchParams;
  const status = query.status === "closed" ? "closed" : "open";
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, locale, me, page, clubs, wards] = await Promise.all([
    getTranslations(),
    getLocale(),
    getMe(),
    getMyTasks(status, cursor),
    getMyClubs(),
    getMyWards(),
  ]);
  // Duties (P2.6): one club at a time (the first unless chosen), the
  // family's: mine and those of the children I act for.
  const dutyClubs = new Map<string, string>();
  for (const c of clubs.clubs) dutyClubs.set(c.club.id, c.club.name);
  for (const w of wards.wards) {
    if (!w.rights.includes("act_on_behalf")) continue;
    for (const c of w.clubs ?? []) if (!dutyClubs.has(c.id)) dutyClubs.set(c.id, c.name);
  }
  const clubId =
    typeof query.clubId === "string" && dutyClubs.has(query.clubId)
      ? query.clubId
      : ([...dutyClubs.keys()][0] ?? null);
  const duties = clubId ? await getMyDuties(clubId) : null;
  const family: Family = {
    me: me.person,
    children: wards.wards.filter((w) => w.rights.includes("act_on_behalf")).map((w) => w.person),
  };
  const back = `/me/tasks${clubId ? `?clubId=${clubId}` : ""}`;
  const day = (iso: string) =>
    formatDateTime(`${iso}T12:00:00Z`, { locale, timeZone: "UTC", dateStyle: "medium" });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("tasks.title")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("tasks.intro")}</p>
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("governing.saved")}</Notice> : null}
      <nav className="flex gap-4 text-sm">
        <a href="/me/tasks" className={status === "open" ? "font-semibold" : "underline"}>
          {t("tasks.open")}
        </a>
        <a
          href="/me/tasks?status=closed"
          className={status === "closed" ? "font-semibold" : "underline"}
        >
          {t("tasks.closed")}
        </a>
      </nav>
      {page.items.length === 0 ? (
        <p className="text-muted" data-testid="tasks-empty">
          {t("tasks.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid="tasks">
          {page.items.map((task) => (
            <li key={task.assignmentId} className="space-y-1 py-3" data-testid="task">
              <p className="font-medium">{task.title}</p>
              <p className="text-sm text-muted">
                {task.groupName ?? task.clubName}
                {task.dueDate ? ` · ${t("tasks.due", { date: day(task.dueDate) })}` : ""}
                {/* A shift's activity is where it is done, not where it was decided. */}
                {task.meeting
                  ? ` · ${task.kind === "duty_shift" ? task.meeting.title : t("tasks.from", { meeting: task.meeting.title })}`
                  : ""}
                {task.person && task.person.id !== me.person.id
                  ? ` · ${t("tasks.for", { person: personLabel(task.person) })}`
                  : ""}
                {` · ${t(enumKey("tasks.statuses", task.status))}`}
              </p>
              {task.kind === "duty_shift" && task.status === "planned" ? (
                <ActionForm action="duty-swap">
                  <input type="hidden" name="clubId" value={task.clubId} />
                  <input type="hidden" name="assignmentId" value={task.assignmentId} />
                  <input type="hidden" name="kind" value="offer" />
                  <input type="hidden" name="back" value={back} />
                  <button type="submit" className={secondaryButtonClass} data-testid="duty-offer">
                    {t("duties.offer")}
                  </button>
                </ActionForm>
              ) : null}
              {/* Shifts (P2.6) are marked by their planners. */}
              {task.kind === "action_item" ? (
                <ActionForm action="tasks-status">
                  <input type="hidden" name="assignmentId" value={task.assignmentId} />
                  <input
                    type="hidden"
                    name="status"
                    value={task.status === "planned" ? "done" : "planned"}
                  />
                  <button type="submit" className={secondaryButtonClass} data-testid="task-toggle">
                    {task.status === "planned" ? t("tasks.markDone") : t("tasks.markPlanned")}
                  </button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <a
          href={`/me/tasks?status=${status}&cursor=${page.nextCursor}`}
          className="text-sm underline"
        >
          {t("announcements.more")}
        </a>
      ) : null}

      {/* Volunteer duties (P2.6): one club at a time. */}
      {duties ? (
        <section aria-labelledby="duties" className="space-y-4 border-t border-border pt-6">
          <h2 id="duties" className="text-xl font-semibold">
            {t("duties.title")}
          </h2>
          {dutyClubs.size > 1 ? (
            <nav className="flex flex-wrap gap-3 text-sm" data-testid="duty-clubs">
              {[...dutyClubs].map(([id, name]) => (
                <a
                  key={id}
                  href={`/me/tasks?clubId=${id}`}
                  className={id === clubId ? "font-semibold" : "underline"}
                >
                  {name}
                </a>
              ))}
            </nav>
          ) : null}
          <MyDutiesSection duties={duties} family={family} back={back} />
        </section>
      ) : null}
    </div>
  );
}
