// SPDX-License-Identifier: AGPL-3.0-only
// "Add member" (P1.3b): a paper application in the register. The person,
// membership, groups and any number of guardians (members of the club, new
// people without login, or invited by email), and an adult's own login.
// Posts to the add-member action; works without client JavaScript (the
// "Add guardian" link then reloads the form with one more).

import { enumKey } from "@clubadmin/i18n";
import {
  ADD_MEMBER_FORM_MAX_GUARDIANS,
  GENDERS,
  GUARDIANSHIP_KINDS,
  isLinkedGuardianshipKind,
  MEMBERSHIP_TYPES,
} from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../../components/action-form.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import { GuardianFieldsets } from "../../../../../../components/guardian-fieldsets.tsx";
import {
  getAdultMembers,
  getClub,
  getClubGroups,
  getMyClubs,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("addMember.title") };
}

export default async function AddMemberPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.members.add")) forbidden();
  const [groups, adults] = await Promise.all([getClubGroups(club.id), getAdultMembers(club.id)]);
  const guardianCount = Math.min(
    Math.max(Number(query.guardians) || 0, 0),
    ADD_MEMBER_FORM_MAX_GUARDIANS,
  );
  const field = (name: string, label: string, props: Record<string, unknown> = {}) => (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input name={name} className={inputClass} data-testid={`add-${name}`} {...props} />
    </label>
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/clubs/${club.id}/members`} className="underline">
          {t("nav.members")}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("addMember.title")}</h1>
      <p>{t("addMember.intro")}</p>
      <FormError code={query.error} />

      <ActionForm action="add-member" className="space-y-6" testId="add-member-form">
        <input type="hidden" name="clubId" value={club.id} />
        <input type="hidden" name="country" value={club.country} />
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-medium">{t("addMember.person")}</legend>
          {field("givenName", t("family.givenName"), { required: true, maxLength: 100 })}
          {field("familyName", t("family.familyName"), { required: true, maxLength: 100 })}
          {field("birthDate", t("addMember.birthDate"), { type: "date" })}
          {field("personalIdentityNumber", t("addMember.personalIdentityNumber"), {
            maxLength: 20,
            autoComplete: "off",
          })}
          <label className="block space-y-1">
            <span className="text-sm">{t("addMember.gender")}</span>
            <select name="gender" className={inputClass} defaultValue="">
              <option value="">{t("addMember.notGiven")}</option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {t(enumKey("genders", g))}
                </option>
              ))}
            </select>
          </label>
          {field("phone", t("family.phone"), { type: "tel" })}
          {field("street", t("addMember.street"), { maxLength: 200 })}
          {field("postalCode", t("addMember.postalCode"), { maxLength: 20 })}
          {field("city", t("addMember.city"), { maxLength: 100 })}
          <label className="flex items-start gap-2 sm:col-span-2">
            <input type="checkbox" name="protectedIdentity" className="mt-1" />
            <span>{t("addMember.protected")}</span>
          </label>
          <p className="text-xs text-muted sm:col-span-2">{t("addMember.birthDateHint")}</p>
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-medium">{t("addMember.membership")}</legend>
          <label className="block space-y-1">
            <span className="text-sm">{t("members.type")}</span>
            <select name="membershipType" className={inputClass} defaultValue="active">
              {MEMBERSHIP_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t(enumKey("membershipTypes", v))}
                </option>
              ))}
            </select>
          </label>
          {field("startDate", t("addMember.startDate"), { type: "date" })}
          {groups.length > 0 ? (
            <div className="space-y-1 sm:col-span-2">
              <span className="text-sm">{t("addMember.groups")}</span>
              <div className="grid gap-1 sm:grid-cols-2">
                {groups
                  .filter((g) => !g.archived)
                  .map((g) => (
                    <label key={g.id} className="inline-flex items-center gap-2">
                      <input type="checkbox" name="groupId" value={g.id} />
                      {g.name}
                    </label>
                  ))}
              </div>
            </div>
          ) : null}
        </fieldset>

        <section className="space-y-2" aria-labelledby="guardians-heading">
          <h2 id="guardians-heading" className="font-medium">
            {t("addMember.guardians")}
          </h2>
          <p className="text-sm text-muted">{t("addMember.guardiansIntro")}</p>
          <GuardianFieldsets
            initial={guardianCount}
            addHref={`/clubs/${club.id}/members/new?guardians=${guardianCount + 1}`}
            members={adults.items.map((m) => ({ id: m.person.id, label: personLabel(m.person) }))}
            kinds={GUARDIANSHIP_KINDS.map((k) => ({
              value: k,
              label: t(enumKey("guardianKinds", k)),
              linked: isLinkedGuardianshipKind(k),
            }))}
            texts={{
              legend: t("addMember.guardian", { number: "{number}" }),
              source: t("addMember.guardianSource"),
              sourceNew: t("addMember.sourceNew"),
              sourceMember: t("addMember.sourceMember"),
              member: t("addMember.member"),
              chooseMember: t("addMember.chooseMember"),
              given: t("family.givenName"),
              family: t("family.familyName"),
              phone: t("family.phone"),
              email: t("addMember.guardianEmail"),
              emailHint: t("addMember.guardianEmailHint"),
              kind: t("family.kind"),
              consentNote: t("addMember.consentNote"),
              consentHint: t("addMember.consentHint"),
              add: t("addMember.addGuardian"),
              remove: t("addMember.removeGuardian"),
            }}
          />
        </section>

        <section className="space-y-2">
          <h2 className="font-medium">{t("addMember.ownLogin")}</h2>
          {field("invitationEmail", t("addMember.invitationEmail"), { type: "email" })}
          <p className="text-xs text-muted">{t("addMember.invitationEmailHint")}</p>
        </section>

        <button type="submit" className={buttonClass} data-testid="add-member-submit">
          {t("addMember.submit")}
        </button>
      </ActionForm>
    </div>
  );
}
