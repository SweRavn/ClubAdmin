// SPDX-License-Identifier: AGPL-3.0-only
// A person's profile as the viewer may see it: the API leaves out fields the
// relationship does not include (docs/domain-model.md, "Field visibility").
import { enumKey } from "@clubadmin/i18n";
import { GUARDIANSHIP_KINDS, MEMBERSHIP_TYPES } from "@clubadmin/shared";
import { personLabel, PersonName, RoleBadge } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../components/action-form.tsx";
import { GuardianRow, RightsFields } from "../../../../components/family.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import {
  getClubGroups,
  getClubGuardians,
  getClubManagers,
  getMe,
  getMyClubs,
  getPerson,
  getRegister,
} from "../../../../server/data.ts";

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
  const [t, locale, profile, me, mine, query] = await Promise.all([
    getTranslations(),
    getLocale(),
    getPerson(personId, clubId),
    getMe(),
    getMyClubs(),
    searchParams,
  ]);
  // Club managers start appointments and hand-overs from an active member's profile (P1.1).
  const managedClub = profile.club
    ? mine.clubs.find(
        (c) => c.club.id === profile.club!.clubId && c.permissions.includes("club.roles.manage"),
      )
    : undefined;
  const isActiveMember = profile.club?.membership?.status === "active";
  // Registrars and club managers change memberships here (P1.2).
  const registerClub = profile.club?.membership
    ? mine.clubs.find(
        (c) => c.club.id === profile.club!.clubId && c.permissions.includes("club.members.manage"),
      )
    : undefined;
  const membership = profile.club?.membership;
  // Guardians as the club sees them, from paper applications and forms (P1.3).
  const guardianClub = profile.club
    ? mine.clubs.find(
        (c) =>
          c.club.id === profile.club!.clubId && c.permissions.includes("club.guardians.manage"),
      )
    : undefined;
  const clubGuardians = guardianClub
    ? await getClubGuardians(guardianClub.club.id, personId)
    : null;
  const guardianQ = typeof query.guardianQ === "string" ? query.guardianQ.trim().slice(0, 100) : "";
  const candidates =
    guardianClub && clubGuardians && guardianQ.length >= 2
      ? (
          await getRegister(
            guardianClub.club.id,
            new URLSearchParams({ q: guardianQ, limit: "10" }).toString(),
          )
        ).items.filter((m) => m.person.id !== personId)
      : [];
  const managers =
    managedClub && isActiveMember && personId !== me.personId
      ? await getClubManagers(managedClub.club.id)
      : null;
  const alreadyManager = managers?.items.some((m) => m.person.id === personId) ?? false;
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
    rows.push({
      key: "gender",
      label: t("person.gender"),
      value: t(enumKey("genders", profile.gender)),
    });
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
      value: t(enumKey("membershipStatus", profile.club.membership.status)),
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
                  <RoleBadge key={fn} label={t(enumKey("functions", fn))} />
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <FormError code={query.error} />
      {query.updated ? <Notice>{t("members.updated")}</Notice> : null}
      {registerClub &&
      membership &&
      membership.status !== "left" &&
      membership.status !== "applied" ? (
        <section
          aria-labelledby="person-membership"
          className="space-y-3"
          data-testid="membership-actions"
        >
          <h2 id="person-membership" className="text-lg font-semibold">
            {t("members.membershipTitle")}
          </h2>
          <p className="text-sm">
            {t(enumKey("membershipTypes", membership.membershipType))}
            {" · "}
            {t(enumKey("membershipStatus", membership.status))}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <ActionForm action="update-membership">
              <input type="hidden" name="clubId" value={registerClub.club.id} />
              <input type="hidden" name="personId" value={personId} />
              <input
                type="hidden"
                name="change"
                value={membership.status === "paused" ? "resume" : "pause"}
              />
              <button type="submit" className={secondaryButtonClass} data-testid="membership-pause">
                {membership.status === "paused" ? t("members.resume") : t("members.pause")}
              </button>
            </ActionForm>
            <ActionForm action="update-membership" className="flex items-end gap-2">
              <input type="hidden" name="clubId" value={registerClub.club.id} />
              <input type="hidden" name="personId" value={personId} />
              <input type="hidden" name="change" value="type" />
              <label className="block space-y-1">
                <span className="text-sm">{t("members.type")}</span>
                <select
                  name="membershipType"
                  defaultValue={membership.membershipType}
                  className={inputClass}
                >
                  {MEMBERSHIP_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(enumKey("membershipTypes", type))}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={secondaryButtonClass}>
                {t("members.changeType")}
              </button>
            </ActionForm>
          </div>
          <ActionForm action="update-membership" className="space-y-2">
            <input type="hidden" name="clubId" value={registerClub.club.id} />
            <input type="hidden" name="personId" value={personId} />
            <input type="hidden" name="change" value="end" />
            <p className="text-sm text-muted">{t("members.endHint")}</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block space-y-1">
                <span className="text-sm">{t("members.endedOn")}</span>
                <input type="date" name="endedOn" className={inputClass} />
              </label>
              <button type="submit" className={secondaryButtonClass} data-testid="membership-end">
                {t("members.end")}
              </button>
            </div>
          </ActionForm>
        </section>
      ) : null}
      {managers && managedClub && !alreadyManager ? (
        <section
          aria-labelledby="person-manager"
          className="space-y-2"
          data-testid="manager-actions"
        >
          <h2 id="person-manager" className="text-lg font-semibold">
            {t("managers.title")}
          </h2>
          <div className="flex flex-wrap gap-2">
            <ActionForm action="appoint-manager">
              <input type="hidden" name="clubId" value={managedClub.club.id} />
              <input type="hidden" name="personId" value={personId} />
              <button type="submit" className={buttonClass}>
                {t("managers.appoint")}
              </button>
            </ActionForm>
            <ActionForm action="propose-handover" back={`/clubs/${managedClub.club.id}/managers`}>
              <input type="hidden" name="clubId" value={managedClub.club.id} />
              <input type="hidden" name="personId" value={personId} />
              <button type="submit" className={secondaryButtonClass} data-testid="propose-handover">
                {t("managers.handOverTo")}
              </button>
            </ActionForm>
          </div>
        </section>
      ) : null}

      {clubGuardians && guardianClub ? (
        <section
          aria-labelledby="club-guardians"
          className="space-y-3"
          data-testid="club-guardians"
        >
          <h2 id="club-guardians" className="text-lg font-semibold">
            {t("person.guardians")}
          </h2>
          {clubGuardians.guardians.length === 0 ? (
            <p className="text-muted">{t("family.club.none")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {clubGuardians.guardians.map((g) => (
                <GuardianRow
                  key={g.guardianshipId}
                  entry={g}
                  allowActOnBehalf={false}
                  clubId={guardianClub.club.id}
                />
              ))}
            </ul>
          )}
          <details>
            <summary className="cursor-pointer" data-testid="open-club-guardian">
              {t("family.club.add")}
            </summary>
            <div className="mt-3 space-y-4">
              <form method="get" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="clubId" value={guardianClub.club.id} />
                <label className="block space-y-1">
                  <span className="text-sm">{t("family.club.search")}</span>
                  <input
                    name="guardianQ"
                    defaultValue={guardianQ}
                    className={inputClass}
                    data-testid="guardian-search"
                  />
                </label>
                <button type="submit" className={secondaryButtonClass}>
                  {t("family.club.searchButton")}
                </button>
              </form>
              {candidates.length ? (
                <ul className="space-y-2" data-testid="guardian-candidates">
                  {candidates.map((m) => (
                    <li key={m.person.id}>
                      <ActionForm
                        action="club-add-guardian"
                        className="flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="clubId" value={guardianClub.club.id} />
                        <input type="hidden" name="personId" value={personId} />
                        <input type="hidden" name="guardianPersonId" value={m.person.id} />
                        <PersonName person={m.person} protectedLabel={protectedLabel} />
                        <select
                          name="kind"
                          className="rounded-md border border-border bg-bg px-2 py-1"
                          defaultValue="parent"
                        >
                          <option value="parent">{t("guardianKinds.parent")}</option>
                          <option value="legal_guardian">
                            {t("guardianKinds.legal_guardian")}
                          </option>
                        </select>
                        <button
                          type="submit"
                          className={secondaryButtonClass}
                          data-testid="add-candidate"
                        >
                          {t("family.add")}
                        </button>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ActionForm
                action="club-add-guardian"
                className="space-y-2 rounded-md border border-border p-3"
                testId="club-guardian-form"
              >
                <h3 className="font-medium">{t("family.club.newPerson")}</h3>
                <input type="hidden" name="clubId" value={guardianClub.club.id} />
                <input type="hidden" name="personId" value={personId} />
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="block space-y-1">
                    <span className="text-sm">{t("family.givenName")}</span>
                    <input name="givenName" required maxLength={100} className={inputClass} />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-sm">{t("family.familyName")}</span>
                    <input name="familyName" required maxLength={100} className={inputClass} />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-sm">{t("family.phone")}</span>
                    <input type="tel" name="phone" className={inputClass} />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span className="text-sm">{t("family.kind")}</span>
                  <select name="kind" className={inputClass} defaultValue="contact_person">
                    {GUARDIANSHIP_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(enumKey("guardianKinds", k))}
                      </option>
                    ))}
                  </select>
                </label>
                <RightsFields
                  selected={["view_schedule", "receive_messages"]}
                  allowActOnBehalf={false}
                  idPrefix="club-guardian"
                />
                <label className="block space-y-1">
                  <span className="text-sm">{t("family.club.consentNote")}</span>
                  <input
                    name="consentNote"
                    maxLength={500}
                    className={inputClass}
                    data-testid="consent-note"
                  />
                  <span className="block text-xs text-muted">{t("family.club.consentHint")}</span>
                </label>
                <button type="submit" className={buttonClass} data-testid="club-guardian-submit">
                  {t("family.add")}
                </button>
              </ActionForm>
            </div>
          </details>
        </section>
      ) : profile.guardians?.length ? (
        <section aria-labelledby="person-guardians">
          <h2 id="person-guardians" className="mb-2 text-lg font-semibold">
            {t("person.guardians")}
          </h2>
          <ul className="space-y-1">
            {profile.guardians.map((g) => (
              <li key={g.person.id} className="flex flex-wrap items-center gap-2">
                <PersonName person={g.person} protectedLabel={protectedLabel} />
                <RoleBadge label={t(enumKey("guardianKinds", g.kind))} />
                {g.phone ? <span className="text-sm text-muted">{g.phone}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
