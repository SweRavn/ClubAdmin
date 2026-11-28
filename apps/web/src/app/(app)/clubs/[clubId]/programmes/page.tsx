// SPDX-License-Identifier: AGPL-3.0-only
// The club's programmes and templates (P2.9): every programme for those who
// read the club's activities, the templates for those who plan activities,
// new club templates for club managers.
import { enumKey } from "@clubadmin/i18n";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Notice } from "../../../../../components/form-error.tsx";
import {
  NewTemplateForm,
  ProgrammeList,
  TemplateList,
} from "../../../../../components/programme-lists.tsx";
import {
  getClub,
  getClubProgrammes,
  getMyClubs,
  getProgrammeTemplates,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("programmes.title") };
}

export default async function ClubProgrammesPage({ params, searchParams }: Props) {
  const [{ clubId }, query, t] = await Promise.all([params, searchParams, getTranslations()]);
  const [club, mine] = await Promise.all([getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  const reads = permissions.includes("club.activities.read");
  const uses = permissions.includes("club.programmes.use");
  if (!reads && !uses) forbidden();
  const [programmes, templates] = await Promise.all([
    reads ? getClubProgrammes(club.id) : null,
    uses ? getProgrammeTemplates(club.id, null) : null,
  ]);
  return (
    <div className="space-y-6" data-testid="club-programmes-page">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("programmes.title")}</h1>
        <p className="max-w-prose text-sm text-muted">{t("programmes.intro")}</p>
      </div>
      {typeof query.saved === "string" ? (
        <Notice>{t(enumKey("programmes.saved", query.saved))}</Notice>
      ) : null}
      {programmes ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("programmes.programmes")}</h2>
          <ProgrammeList clubId={club.id} programmes={programmes.items} />
        </section>
      ) : null}
      {templates ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("programmes.templates")}</h2>
          <TemplateList clubId={club.id} templates={templates.items} />
          {permissions.includes("club.programmes.manage") ? (
            <NewTemplateForm clubId={club.id} scope="club" />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
