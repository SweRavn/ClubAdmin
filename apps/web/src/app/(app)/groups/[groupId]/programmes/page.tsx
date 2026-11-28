// SPDX-License-Identifier: AGPL-3.0-only
// A group's programmes (P2.9) for everyone who sees its activities; for its
// planners also the templates they may lay out (the group's and the club's),
// a new template and the group's activities of a range saved as one.
import { enumKey } from "@clubadmin/i18n";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  NewTemplateForm,
  ProgrammeList,
  TemplateList,
} from "../../../../../components/programme-lists.tsx";
import { getGroup, getGroupProgrammes, getProgrammeTemplates } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("programmes.title") };
}

export default async function GroupProgrammesPage({ params, searchParams }: Props) {
  const [{ groupId }, query, t] = await Promise.all([params, searchParams, getTranslations()]);
  const group = await getGroup(groupId);
  const [programmes, templates] = await Promise.all([
    getGroupProgrammes(group.id),
    getProgrammeTemplates(group.clubId, group.id),
  ]);
  const own = templates?.items.filter((x) => x.groupId === null || x.groupId === group.id) ?? [];
  return (
    <div className="space-y-6" data-testid="group-programmes-page">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a href={`/groups/${group.id}`} className="underline">
            {group.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("programmes.title")}</h1>
      </div>
      <FormError code={query.error} />
      {typeof query.saved === "string" ? (
        <Notice>{t(enumKey("programmes.saved", query.saved))}</Notice>
      ) : null}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t("programmes.programmes")}</h2>
        <ProgrammeList clubId={group.clubId} programmes={programmes.items} />
      </section>
      {templates ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("programmes.templates")}</h2>
          <TemplateList clubId={group.clubId} templates={own} />
          <NewTemplateForm clubId={group.clubId} scope={group.id} />
          <ActionForm
            action="programme-template-create"
            className="grid max-w-xl gap-2 sm:grid-cols-3"
            testId="template-from-range"
          >
            <input type="hidden" name="clubId" value={group.clubId} />
            <input type="hidden" name="scope" value={group.id} />
            <input type="hidden" name="sourceKind" value="range" />
            <input type="hidden" name="groupId" value={group.id} />
            <p className="font-medium sm:col-span-3">{t("programmes.fromRange")}</p>
            <label className="block space-y-1 sm:col-span-3">
              <span className="text-sm">{t("programmes.templateName")}</span>
              <input name="name" required maxLength={120} className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm">{t("programmes.from")}</span>
              <input type="date" name="from" required className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm">{t("programmes.to")}</span>
              <input type="date" name="to" required className={inputClass} />
            </label>
            <div className="flex items-end">
              <button type="submit" className={secondaryButtonClass}>
                {t("programmes.saveAsTemplate")}
              </button>
            </div>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
