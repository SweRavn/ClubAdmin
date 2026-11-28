// SPDX-License-Identifier: AGPL-3.0-only
// Laying out a template (P2.9, ADR 0054 decision 9): first day, groups per
// slot, places to replace, the preview, then everything at once.
import { getTranslations } from "next-intl/server";

import {
  choicesOf,
  layoutRequest,
  ProgrammeLayout,
} from "../../../../../../../components/programme-layout.tsx";
import {
  getClub,
  getClubGroups,
  getLocations,
  getProgrammeTemplate,
  previewProgramme,
} from "../../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; templateId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const { clubId, templateId } = await params;
  const template = await getProgrammeTemplate(clubId, templateId);
  return { title: (await getTranslations())("programmes.layOutTitle", { name: template.name }) };
}

export default async function ApplyTemplatePage({ params, searchParams }: Props) {
  const [{ clubId, templateId }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
  ]);
  const [club, template] = await Promise.all([
    getClub(clubId),
    getProgrammeTemplate(clubId, templateId),
  ]);
  const [groups, active, archived] = await Promise.all([
    getClubGroups(club.id),
    getLocations(club.id),
    getLocations(club.id, true),
  ]);
  const used = [...new Set(template.items.flatMap((i) => (i.locationId ? [i.locationId] : [])))];
  const known = new Map<string, { id: string; name: string; archived: boolean }>([
    ...active.map((l) => [l.id, { id: l.id, name: l.name, archived: false }] as const),
    ...archived.map((l) => [l.id, { id: l.id, name: l.name, archived: true }] as const),
  ]);
  const { choices, asked } = choicesOf(query, template.slots, used);
  const result = asked
    ? await previewProgramme(club.id, { templateId: template.id }, layoutRequest(choices, true))
    : { preview: null, error: null };
  const path = `/clubs/${club.id}/programme-templates/${template.id}/apply`;
  return (
    <div className="space-y-6" data-testid="programme-apply-page">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}/programme-templates/${template.id}`} className="underline">
            {template.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">
          {t("programmes.layOutTitle", { name: template.name })}
        </h1>
        <p className="max-w-prose text-sm text-muted">{t("programmes.layOutIntro")}</p>
      </div>
      <ProgrammeLayout
        clubId={club.id}
        action="programme-apply"
        hidden={{ templateId: template.id }}
        path={path}
        slots={template.slots}
        places={used.flatMap((id) => (known.get(id) ? [known.get(id)!] : []))}
        groups={groups.filter((g) => !g.archived).map((g) => ({ id: g.id, name: g.name }))}
        locations={active.map((l) => ({ id: l.id, name: l.name }))}
        choices={choices}
        preview={result.preview}
        error={result.error}
        withEdition
      />
    </div>
  );
}
