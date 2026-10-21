// SPDX-License-Identifier: AGPL-3.0-only
// A person's profile as the viewer may see it: the API leaves out fields the
// relationship does not include (docs/domain-model.md, "Field visibility").

import { personLabel, PersonName, RoleBadge } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { getClubGroups, getPerson } from "../../../../server/data.ts";

type Props = {
  params: Promise<{ personId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const clubIdOf = async (searchParams: Props["searchParams"]) => {
  const value = (await searchParams).clubId;
  return typeof value === "string" ? value : null;
};

export async function generateMetadata({ params, searchParams }: Props) {
  const profile = await getPerson((await params).personId, await clubIdOf(searchParams));
  return { title: personLabel(profile.person) };
}

export default async function PersonPage({ params, searchParams }: Props) {
  const { personId } = await params;
  const clubId = await clubIdOf(searchParams);
  const [t, locale, profile] = await Promise.all([
    getTranslations(),
    getLocale(),
    getPerson(personId, clubId),
  ]);
  const groupNames = profile.club?.groups?.length
    ? new Map((await getClubGroups(profile.club.clubId)).map((g) => [g.id, g.name]))
    : new Map<string, string>();
  const protectedLabel = t("protected.tooltip");
  const rows: { key: string; label: string; value: string }[] = [];
  if (profile.birthDate)
    rows.push({
      key: "birthDate",
      label: t("person.birthDate"),
      // A calendar date: formatted without a time zone shift.
      value: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
        new Date(`${profile.birthDate}T00:00:00Z`),
      ),
    });
  if (profile.gender)
    rows.push({ key: "gender", label: t("person.gender"), value: t(`genders.${profile.gender}`) });
  if (profile.phone) rows.push({ key: "phone", label: t("person.phone"), value: profile.phone });
  if (profile.address)
    rows.push({
      key: "address",
      label: t("person.address"),
      value: [
        profile.address.street,
        `${profile.address.postalCode} ${profile.address.city}`,
        profile.address.country,
      ]
        .filter(Boolean)
        .join(", "),
    });
  if (profile.club?.memberNumber !== undefined)
    rows.push({
      key: "memberNumber",
      label: t("person.memberNumber"),
      value: String(profile.club.memberNumber),
    });
  if (profile.club?.membership)
    rows.push({
      key: "membership",
      label: t("person.membership"),
      value: t(`membershipStatus.${profile.club.membership.status}`),
    });

  return (
    <div className="space-y-8" data-testid="person-profile">
      <h1 className="text-2xl font-semibold">
        <PersonName person={profile.person} protectedLabel={protectedLabel} />
      </h1>
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {rows.map((row) => (
            <div key={row.key} className="contents" data-field={row.key}>
              <dt className="text-muted">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted">{t("person.limited")}</p>
      )}

      {profile.club?.groups?.length ? (
        <section aria-labelledby="person-groups">
          <h2 id="person-groups" className="mb-2 text-lg font-semibold">
            {t("person.groups")}
          </h2>
          <ul className="space-y-1">
            {profile.club.groups.map((g) => (
              <li key={g.groupId} className="flex flex-wrap items-center gap-2">
                <a href={`/groups/${g.groupId}`} className="text-accent underline">
                  {groupNames.get(g.groupId) ?? g.groupId}
                </a>
                {g.functions.map((fn) => (
                  <RoleBadge key={fn} label={t(`functions.${fn}`)} />
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {profile.guardians?.length ? (
        <section aria-labelledby="person-guardians">
          <h2 id="person-guardians" className="mb-2 text-lg font-semibold">
            {t("person.guardians")}
          </h2>
          <ul className="space-y-1">
            {profile.guardians.map((g) => (
              <li key={g.person.id} className="flex flex-wrap items-center gap-2">
                <PersonName person={g.person} protectedLabel={protectedLabel} />
                <RoleBadge label={t(`guardianKinds.${g.kind}`)} />
                {g.phone ? <span className="text-sm text-muted">{g.phone}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
