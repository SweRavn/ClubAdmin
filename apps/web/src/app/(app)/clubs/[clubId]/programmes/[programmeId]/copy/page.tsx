// SPDX-License-Identifier: AGPL-3.0-only
// Copying a programme to a new date (P2.9, ADR 0054 decision 9): a template
// made on the fly and not kept; everything but people.
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
  getProgramme,
  previewProgramme,
} from "../../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; programmeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const { clubId, programmeId } = await params;
  const programme = await getProgramme(clubId, programmeId);
  return { title: (await getTranslations())("programmes.copyTitle", { title: programme.title }) };
}

export default async function CopyProgrammePage({ params, searchParams }: Props) {
  const [{ clubId, programmeId }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
  ]);
  const [club, programme] = await Promise.all([getClub(clubId), getProgramme(clubId, programmeId)]);
  const [groups, active] = await Promise.all([getClubGroups(club.id), getLocations(club.id)]);
  // Copying keeps the groups: each slot is one of the programme's groups, by its ID.
  const slots = programme.groups.map((g) => ({ key: g.id, label: g.name, defaultGroupId: g.id }));
  const places = programme.places.flatMap((p) =>
    p.locationId ? [{ id: p.locationId, name: p.name ?? "", archived: false }] : [],
  );
  const { choices, asked } = choicesOf(
    query,
    slots,
    places.map((p) => p.id),
  );
  const result = asked
    ? await previewProgramme(club.id, { programmeId: programme.id }, layoutRequest(choices, false))
    : { preview: null, error: null };
  return (
    <div className="space-y-6" data-testid="programme-copy-page">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}/programmes/${programme.id}`} className="underline">
            {programme.title}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">
          {t("programmes.copyTitle", { title: programme.title })}
        </h1>
        <p className="max-w-prose text-sm text-muted">{t("programmes.copyIntro")}</p>
      </div>
      <ProgrammeLayout
        clubId={club.id}
        action="programme-copy"
        hidden={{ programmeId: programme.id }}
        path={`/clubs/${club.id}/programmes/${programme.id}/copy`}
        slots={slots}
        places={places}
        groups={groups.filter((g) => !g.archived).map((g) => ({ id: g.id, name: g.name }))}
        locations={active.map((l) => ({ id: l.id, name: l.name }))}
        choices={choices}
        preview={result.preview}
        error={result.error}
        withEdition={false}
      />
    </div>
  );
}
