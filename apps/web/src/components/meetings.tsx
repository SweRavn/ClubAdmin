// SPDX-License-Identifier: AGPL-3.0-only
// A meeting's agenda on the web (P2.4, ADR 0049): the items with their
// minutes, decisions, papers and action items. Whoever may edit the meeting
// edits the whole agenda in one form (an empty row adds an item or an
// action item; "remove" leaves one out), starts it from a template and
// assembles the minutes into a governing document. Presenters and assignees
// come from the PersonPresenter (ADR 0022); the pickers list the meeting's
// group (a board meeting) or the club's adult members (the annual meeting).
import { enumKey } from "@clubadmin/i18n";
import { type Agenda, type PersonSummary, TASK_ASSIGNMENT_STATUSES } from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";
import { FormError, Notice } from "./form-error.tsx";
import { Markdown } from "./markdown.tsx";

/** The link to a meeting's agenda and minutes (activity and event pages). */
export async function AgendaLink({ href }: { href: string }) {
  const t = await getTranslations();
  return (
    <p>
      <a href={href} className="text-accent underline" data-testid="agenda-link">
        {t("meetings.agendaLink")}
      </a>
    </p>
  );
}

export async function MeetingAgenda({
  agenda,
  clubId,
  people,
  templates,
  series,
  query,
}: {
  agenda: Agenda;
  clubId: string;
  /** Who may present or be responsible (empty: the editor keeps who is set). */
  people: readonly PersonSummary[];
  templates: readonly { name: string; items: readonly { title: string }[] }[];
  /** The series the minutes may go in. */
  series: readonly { id: string; name: string }[];
  query: Record<string, string | string[] | undefined>;
}) {
  const t = await getTranslations();
  const kind = agenda.meeting.kind;
  const hidden = (
    <>
      <input type="hidden" name="meetingKind" value={kind} />
      <input type="hidden" name="meetingId" value={agenda.meeting.id} />
      <input type="hidden" name="clubId" value={clubId} />
    </>
  );
  const known = new Map(people.map((p) => [p.id, p]));
  for (const item of agenda.items) {
    if (item.presenter) known.set(item.presenter.id, item.presenter);
    for (const a of item.actions)
      for (const x of a.assignees) if (x.person) known.set(x.person.id, x.person);
  }
  const options = [...known.values()];
  const personSelect = (name: string, current: string | null, required = false) => (
    <select name={name} defaultValue={current ?? ""} className={inputClass} required={required}>
      <option value="">{t("meetings.nobody")}</option>
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {personLabel(p)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {t("meetings.agenda")} · {agenda.meeting.title}
        </h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("meetings.intro")}</p>
        {agenda.minutesDocumentId ? (
          <p className="mt-1 text-sm">
            <a
              href={`/clubs/${clubId}/governing/${agenda.minutesDocumentId}`}
              className="underline"
              data-testid="minutes-link"
            >
              {t("meetings.minutesDocument")}
            </a>
          </p>
        ) : null}
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("governing.saved")}</Notice> : null}

      {!agenda.canEdit ? (
        <>
          <p className="text-sm text-muted">{t("meetings.readOnly")}</p>
          {agenda.items.length === 0 ? <p className="text-muted">{t("meetings.empty")}</p> : null}
          <ol className="space-y-4" data-testid="agenda">
            {agenda.items.map((item) => (
              <li key={item.id} className="space-y-1">
                <h2 className="font-semibold">
                  {t("meetings.item", { position: item.position })} {item.title}
                </h2>
                {item.presenter ? (
                  <p className="text-sm text-muted">
                    {t("meetings.presenter")}: {personLabel(item.presenter)}
                  </p>
                ) : null}
                {item.minutes ? <Markdown source={item.minutes} /> : null}
                {item.decisions.length > 0 ? (
                  <ul className="list-disc pl-6 text-sm">
                    {item.decisions.map((d) => (
                      <li key={d.id}>{d.text}</li>
                    ))}
                  </ul>
                ) : null}
                {item.papers.map((p) => (
                  <a
                    key={p.id}
                    href={`/clubs/${clubId}/documents/${p.id}`}
                    className="block text-sm underline"
                  >
                    {p.name}
                  </a>
                ))}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          {agenda.items.length === 0 && templates.length > 0 ? (
            <section className="space-y-2" data-testid="templates">
              <h2 className="font-semibold">{t("meetings.fromTemplate")}</h2>
              <div className="flex flex-wrap gap-2">
                {templates.map((tpl, i) => (
                  <ActionForm key={i} action="agenda-from-template">
                    {hidden}
                    {tpl.items.map((item, j) => (
                      <input key={j} type="hidden" name="templateItem" value={item.title} />
                    ))}
                    <button type="submit" className={secondaryButtonClass}>
                      {t("meetings.useTemplate", { name: tpl.name })}
                    </button>
                  </ActionForm>
                ))}
              </div>
            </section>
          ) : null}
          <ActionForm action="agenda-save" className="space-y-6" testId="agenda-editor">
            {hidden}
            {[...agenda.items, null].map((item, n) => (
              <fieldset
                key={item?.id ?? "new"}
                className="space-y-2 rounded-md border border-border p-3"
                data-testid="agenda-item"
              >
                <legend className="px-1 text-sm font-medium">
                  {item ? t("meetings.item", { position: item.position }) : t("meetings.newItem")}
                </legend>
                {item ? <input type="hidden" name={`item.${n}.id`} value={item.id} /> : null}
                <label className="block text-sm">
                  {t("meetings.title")}
                  <input
                    name={`item.${n}.title`}
                    defaultValue={item?.title ?? ""}
                    maxLength={200}
                    className={inputClass}
                  />
                </label>
                <label className="block text-sm">
                  {t("meetings.presenter")}
                  {personSelect(`item.${n}.presenter`, item?.presenter?.id ?? null)}
                </label>
                <label className="block text-sm">
                  {t("meetings.minutes")}
                  <textarea
                    name={`item.${n}.minutes`}
                    rows={3}
                    defaultValue={item?.minutes ?? ""}
                    className={inputClass}
                  />
                </label>
                <label className="block text-sm">
                  {t("meetings.decisions")}
                  <textarea
                    name={`item.${n}.decisions`}
                    rows={2}
                    defaultValue={item?.decisions.map((d) => d.text).join("\n") ?? ""}
                    className={inputClass}
                  />
                </label>
                {item && item.papers.length > 0 ? (
                  <div className="text-sm">
                    <input type="hidden" name={`item.${n}.papersShown`} value="1" />
                    {t("meetings.papers")}:{" "}
                    {item.papers.map((p) => (
                      <label key={p.id} className="mr-3 inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          name={`item.${n}.paper`}
                          value={p.id}
                          defaultChecked
                        />
                        {p.name}
                      </label>
                    ))}
                  </div>
                ) : null}
                <div className="space-y-2">
                  <input type="hidden" name={`item.${n}.actionsShown`} value="1" />
                  <p className="text-sm font-medium">{t("meetings.actions")}</p>
                  {[...(item?.actions ?? []), null].map((a, m) => {
                    const assignee = a?.assignees[0];
                    return (
                      <div
                        key={a?.taskId ?? "new"}
                        className="grid gap-2 sm:grid-cols-4"
                        data-testid="agenda-action"
                      >
                        {a ? (
                          <input
                            type="hidden"
                            name={`item.${n}.action.${m}.taskId`}
                            value={a.taskId}
                          />
                        ) : null}
                        <input
                          name={`item.${n}.action.${m}.title`}
                          defaultValue={a?.title ?? ""}
                          placeholder={a ? undefined : t("meetings.newAction")}
                          aria-label={t("meetings.actionTitle")}
                          maxLength={200}
                          className={inputClass}
                        />
                        <input
                          type="date"
                          name={`item.${n}.action.${m}.dueDate`}
                          defaultValue={a?.dueDate ?? ""}
                          aria-label={t("meetings.dueDate")}
                          className={inputClass}
                        />
                        {personSelect(
                          `item.${n}.action.${m}.assignee`,
                          assignee?.person?.id ?? null,
                        )}
                        <select
                          name={`item.${n}.action.${m}.status`}
                          defaultValue={assignee?.status ?? "planned"}
                          aria-label={t("meetings.status")}
                          className={inputClass}
                        >
                          {TASK_ASSIGNMENT_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {t(enumKey("meetings.statuses", s))}
                            </option>
                          ))}
                        </select>
                        {a ? (
                          <label className="flex items-center gap-1 text-sm">
                            <input
                              type="checkbox"
                              name={`item.${n}.action.${m}.remove`}
                              value="1"
                            />
                            {t("meetings.remove")}
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {item ? (
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" name={`item.${n}.remove`} value="1" />
                    {t("meetings.remove")}
                  </label>
                ) : null}
              </fieldset>
            ))}
            <button type="submit" className={buttonClass} data-testid="save-agenda">
              {t("meetings.save")}
            </button>
          </ActionForm>
          {agenda.items.length > 0 ? (
            <ActionForm action="minutes-assemble" className="space-y-2" testId="assemble">
              {hidden}
              <h2 className="font-semibold">{t("meetings.assemble")}</h2>
              <p className="text-sm text-muted">{t("meetings.assembleHelp")}</p>
              {agenda.minutesDocumentId ? null : (
                <label className="block text-sm">
                  {t("meetings.series")}
                  <select name="seriesId" className={inputClass} required>
                    {series.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button type="submit" className={secondaryButtonClass}>
                {t("meetings.assemble")}
              </button>
            </ActionForm>
          ) : null}
        </>
      )}
    </div>
  );
}
