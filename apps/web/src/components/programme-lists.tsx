// SPDX-License-Identifier: AGPL-3.0-only
// The programmes and templates of a club or a group (P2.9): coming and past
// programmes by first day, templates (the group's and the club's) with what
// they hold, and a new empty template.
import type { ProgrammeSummary, ProgrammeTemplateSummary } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, inputClass, secondaryButtonClass } from "./action-form.tsx";

export async function ProgrammeList({
  clubId,
  programmes,
}: {
  clubId: string;
  programmes: readonly ProgrammeSummary[];
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const day = (d: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(`${d}T12:00:00Z`),
    );
  if (programmes.length === 0) return <p className="text-muted">{t("programmes.none")}</p>;
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border"
      data-testid="programme-list"
    >
      {programmes.map((p) => (
        <li key={p.id} className="p-3">
          <a
            href={`/clubs/${clubId}/programmes/${p.id}`}
            className="font-medium underline"
            data-testid={`programme-link-${p.id}`}
          >
            {p.title}
          </a>
          <p className="text-sm text-muted">
            {p.firstDay === p.lastDay ? day(p.firstDay) : `${day(p.firstDay)} – ${day(p.lastDay)}`}
            {p.edition ? ` · ${p.edition}` : ""}
            {p.groups.length > 0 ? ` · ${p.groups.map((g) => g.name).join(", ")}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

export async function TemplateList({
  clubId,
  templates,
}: {
  clubId: string;
  templates: readonly ProgrammeTemplateSummary[];
}) {
  const t = await getTranslations();
  if (templates.length === 0) return <p className="text-muted">{t("programmes.noTemplates")}</p>;
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border"
      data-testid="template-list"
    >
      {templates.map((x) => (
        <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div>
            <a
              href={`/clubs/${clubId}/programme-templates/${x.id}`}
              className="font-medium underline"
              data-testid={`template-link-${x.id}`}
            >
              {x.name}
            </a>
            <p className="text-sm text-muted">
              {x.groupId ? t("programmes.groupTemplate") : t("programmes.clubTemplate")} ·{" "}
              {t("programmes.dayCount", { count: x.dayCount })} ·{" "}
              {t("programmes.itemCount", { count: x.itemCount })}
              {x.hasEvent ? ` · ${t("programmes.withEvent")}` : ""}
            </p>
          </div>
          <a
            href={`/clubs/${clubId}/programme-templates/${x.id}/apply`}
            className={secondaryButtonClass}
          >
            {t("programmes.layOut")}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A new empty template of the club or of a group. */
export async function NewTemplateForm({ clubId, scope }: { clubId: string; scope: string }) {
  const t = await getTranslations();
  return (
    <ActionForm
      action="programme-template-create"
      className="flex max-w-xl flex-wrap items-end gap-2"
      testId="new-template"
    >
      <input type="hidden" name="clubId" value={clubId} />
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="sourceKind" value="empty" />
      <label className="block flex-1 space-y-1">
        <span className="font-medium">{t("programmes.templateName")}</span>
        <input name="name" required maxLength={120} className={inputClass} />
      </label>
      <button type="submit" className={secondaryButtonClass}>
        {t("programmes.newTemplate")}
      </button>
    </ActionForm>
  );
}
