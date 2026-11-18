// SPDX-License-Identifier: AGPL-3.0-only
// "Mina uppgifter" (P2.4, ADR 0052): the action items given to the viewer
// and their children across clubs, open ones by due date or the done ones;
// the assignee marks them done (or not done after all).
import { enumKey } from "@clubadmin/i18n";
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, secondaryButtonClass } from "../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { getMe, getMyTasks } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("tasks.title") };
}

export default async function MyTasksPage({ searchParams }: Props) {
  const query = await searchParams;
  const status = query.status === "closed" ? "closed" : "open";
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, locale, me, page] = await Promise.all([
    getTranslations(),
    getLocale(),
    getMe(),
    getMyTasks(status, cursor),
  ]);
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
                {task.meeting ? ` · ${t("tasks.from", { meeting: task.meeting.title })}` : ""}
                {task.person && task.person.id !== me.person.id
                  ? ` · ${t("tasks.for", { person: personLabel(task.person) })}`
                  : ""}
                {` · ${t(enumKey("tasks.statuses", task.status))}`}
              </p>
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
    </div>
  );
}
