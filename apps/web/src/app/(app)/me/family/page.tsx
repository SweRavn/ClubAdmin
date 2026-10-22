// SPDX-License-Identifier: AGPL-3.0-only
// My family (P1.3): duplicates to merge, my children with their guardians,
// relatives and contact persons (invite, link without login, change rights,
// resend or revoke invitations, give own login, end my guardianship), what
// is shared with me as a relative or contact person, the people who help me,
// and "Add child".

import { enumKey } from "@clubadmin/i18n";
import { personLabel, PersonName, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../components/action-form.tsx";
import {
  ageOf,
  GuardianRow,
  LinkForms,
  PendingInvitations,
} from "../../../../components/family.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import {
  getFamilyDuplicates,
  getMe,
  getMyWards,
  getTrustedPeople,
  getWardGuardians,
} from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const NOTICES = [
  "added",
  "invited",
  "linked",
  "resent",
  "updated",
  "ended",
  "accepted",
  "ownLogin",
  "merged",
  "undone",
] as const;

export async function generateMetadata() {
  return { title: (await getTranslations())("family.title") };
}

export default async function FamilyPage({ searchParams }: Props) {
  const [t, me, mine, trusted, duplicates, query] = await Promise.all([
    getTranslations(),
    getMe(),
    getMyWards(),
    getTrustedPeople(),
    getFamilyDuplicates(),
    searchParams,
  ]);
  const children = mine.wards.filter((w) => w.kind === "parent" || w.kind === "legal_guardian");
  const sharedWithMe = mine.wards.filter(
    (w) => w.kind === "relative" || w.kind === "contact_person",
  );
  // One read per child (a family has a handful).
  const [guardians, shared] = await Promise.all([
    Promise.all(children.map((w) => getWardGuardians(w.person.id))),
    Promise.all(sharedWithMe.map((w) => getWardGuardians(w.person.id))),
  ]);
  const notice = NOTICES.find((key) => typeof query[key] === "string");
  const protectedLabel = t("protected.tooltip");
  const date = (value: string) => new Date(value);

  return (
    <div className="space-y-8" data-testid="family">
      <h1 className="text-2xl font-semibold">{t("family.title")}</h1>
      <FormError code={query.error} />
      {notice ? (
        <Notice>
          {notice === "accepted" && query.accepted === "protected"
            ? t("family.notices.acceptedProtected")
            : t(`family.notices.${notice}`)}
        </Notice>
      ) : null}

      {duplicates.pairs.length > 0 || duplicates.merges.length > 0 ? (
        <section aria-labelledby="family-duplicates" className="space-y-3" data-testid="duplicates">
          <h2 id="family-duplicates" className="text-lg font-semibold">
            {t("family.duplicates.title")}
          </h2>
          {duplicates.pairs.map((pair) => (
            <div
              key={`${pair.person.person.id}-${pair.duplicate.person.id}`}
              className="space-y-2 rounded-md border border-protected p-3"
              data-testid="duplicate-pair"
            >
              <p>{t("family.duplicates.notice", { name: personLabel(pair.person.person) })}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[pair.person, pair.duplicate].map((side) => (
                  <dl key={side.person.id} className="rounded-md bg-surface p-2 text-sm">
                    <dt className="font-medium">
                      <PersonName person={side.person} protectedLabel={protectedLabel} />
                    </dt>
                    <dd>
                      {side.birthDate
                        ? t("family.born", { date: date(`${side.birthDate}T00:00:00Z`) })
                        : null}
                    </dd>
                    <dd>
                      {side.clubs.length
                        ? side.clubs.map((c) => c.name).join(", ")
                        : t("family.duplicates.noClubs")}
                    </dd>
                    <dd>
                      {t("family.duplicates.guardians", {
                        names: side.guardians.map((g) => personLabel(g)).join(", "),
                      })}
                    </dd>
                  </dl>
                ))}
              </div>
              {pair.canMerge ? (
                <ActionForm action="merge-people">
                  <input type="hidden" name="personId" value={pair.person.person.id} />
                  <input type="hidden" name="duplicatePersonId" value={pair.duplicate.person.id} />
                  <button type="submit" className={buttonClass} data-testid="merge">
                    {t("family.duplicates.merge")}
                  </button>
                </ActionForm>
              ) : (
                <p className="text-sm text-muted">{t("family.duplicates.otherMerges")}</p>
              )}
            </div>
          ))}
          {duplicates.merges.map((merge) => (
            <ActionForm
              key={merge.mergeId}
              action="undo-merge"
              className="flex flex-wrap items-center gap-2"
              testId="undo-merge"
            >
              <input type="hidden" name="mergeId" value={merge.mergeId} />
              <span className="text-sm">
                {t("family.duplicates.merged", {
                  name: personLabel(merge.kept),
                  date: date(merge.undoUntil),
                })}
              </span>
              <button type="submit" className={buttonClass} data-testid="undo">
                {t("family.duplicates.undo")}
              </button>
            </ActionForm>
          ))}
        </section>
      ) : null}

      <section aria-labelledby="family-children" className="space-y-6">
        <h2 id="family-children" className="text-lg font-semibold">
          {t("family.children")}
        </h2>
        {children.length === 0 ? <p className="text-muted">{t("family.noChildren")}</p> : null}
        {children.map((ward, index) => {
          const list = guardians[index]!;
          const age = ward.birthDate ? ageOf(ward.birthDate) : null;
          const ownLogin =
            ward.hasLogin === false &&
            age !== null &&
            ward.ownLoginFromAge !== undefined &&
            age >= ward.ownLoginFromAge;
          return (
            <article
              key={ward.person.id}
              className="space-y-3 rounded-md border border-border p-4"
              data-testid="ward"
              data-person={ward.person.id}
            >
              <h3 className="flex flex-wrap items-center gap-2 text-lg font-medium">
                <a href={`/people/${ward.person.id}`} className="underline">
                  <PersonName person={ward.person} protectedLabel={protectedLabel} />
                </a>
                {age !== null ? (
                  <span className="text-sm text-muted">{t("family.age", { age })}</span>
                ) : null}
                {ward.hasLogin ? <RoleBadge label={t("family.hasLogin")} /> : null}
              </h3>
              {ward.clubs?.length ? (
                <p className="text-sm text-muted">{ward.clubs.map((c) => c.name).join(", ")}</p>
              ) : null}
              <p className="text-sm">
                {t("family.myRights", {
                  rights: ward.rights.map((r) => t(enumKey("guardianRights", r))).join(", "),
                })}
              </p>
              <h4 className="font-medium">
                {t("family.guardiansOf", { name: personLabel(ward.person) })}
              </h4>
              <ul className="divide-y divide-border">
                {list.guardians.map((g) => (
                  <GuardianRow key={g.guardianshipId} entry={g} allowActOnBehalf />
                ))}
              </ul>
              <PendingInvitations invitations={list.invitations} />
              <details>
                <summary className="cursor-pointer" data-testid="open-invite">
                  {t("family.invite")}
                </summary>
                <div className="mt-3">
                  <LinkForms
                    wardId={ward.person.id}
                    selfId={me.personId}
                    fullKinds
                    allowActOnBehalf
                  />
                </div>
              </details>
              {ownLogin ? (
                <details>
                  <summary className="cursor-pointer" data-testid="open-own-login">
                    {t("family.ownLogin.title")}
                  </summary>
                  <ActionForm action="give-own-login" className="mt-2 space-y-2">
                    <input type="hidden" name="personId" value={ward.person.id} />
                    <label className="block space-y-1">
                      <span className="text-sm">{t("family.ownLogin.email")}</span>
                      <input
                        type="email"
                        name="email"
                        required
                        className={inputClass}
                        data-testid="own-login-email"
                      />
                    </label>
                    <button type="submit" className={buttonClass} data-testid="own-login-submit">
                      {t("family.ownLogin.send")}
                    </button>
                  </ActionForm>
                </details>
              ) : null}
              {ward.hasLogin === false && ward.ownLoginFromAge !== undefined ? (
                <p className="text-xs text-muted">
                  {t("family.ownLogin.rule", { age: ward.ownLoginFromAge })}
                </p>
              ) : null}
            </article>
          );
        })}
      </section>

      {sharedWithMe.length > 0 ? (
        <section aria-labelledby="family-shared" className="space-y-3" data-testid="shared-with-me">
          <h2 id="family-shared" className="text-lg font-semibold">
            {t("family.sharedWithMe")}
          </h2>
          <ul className="divide-y divide-border">
            {sharedWithMe.map((w, index) => {
              const own = shared[index]!.guardians.find((g) => g.isYou);
              return (
                <li key={w.person.id} className="space-y-1 py-2" data-testid="shared-ward">
                  <div className="flex flex-wrap items-center gap-2">
                    <PersonName person={w.person} protectedLabel={protectedLabel} />
                  </div>
                  {own ? (
                    <ul>
                      <GuardianRow entry={own} allowActOnBehalf={false} />
                    </ul>
                  ) : null}
                  <p className="text-sm text-muted">
                    {t("family.sharedGuardians", {
                      names: shared[index]!.guardians.filter(
                        (g) => g.kind === "parent" || g.kind === "legal_guardian",
                      )
                        .map((g) => personLabel(g.person))
                        .join(", "),
                    })}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="family-helpers" className="space-y-3" data-testid="trusted-people">
        <h2 id="family-helpers" className="text-lg font-semibold">
          {t("family.helpers.title")}
        </h2>
        <p className="text-sm text-muted">{t("family.helpers.intro")}</p>
        {trusted.people.length === 0 ? (
          <p className="text-muted">{t("family.helpers.none")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {trusted.people.map((g) => (
              <GuardianRow key={g.guardianshipId} entry={g} allowActOnBehalf={trusted.canLink} />
            ))}
          </ul>
        )}
        <PendingInvitations invitations={trusted.invitations} />
        {trusted.canLink ? (
          <details>
            <summary className="cursor-pointer" data-testid="open-helper">
              {t("family.helpers.add")}
            </summary>
            <div className="mt-3">
              <LinkForms
                wardId={me.personId}
                selfId={me.personId}
                fullKinds={false}
                allowActOnBehalf
              />
            </div>
          </details>
        ) : (
          <p className="text-sm text-muted">{t("family.helpers.tooYoung")}</p>
        )}
      </section>

      <section aria-labelledby="family-add" className="space-y-3">
        <h2 id="family-add" className="text-lg font-semibold">
          {t("family.addChild.title")}
        </h2>
        <p className="text-sm text-muted">{t("family.addChild.intro")}</p>
        <ActionForm action="add-child" className="grid gap-3 sm:grid-cols-2" testId="add-child">
          <label className="block space-y-1">
            <span className="text-sm">{t("family.givenName")}</span>
            <input
              name="givenName"
              required
              maxLength={100}
              className={inputClass}
              data-testid="child-given"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("family.familyName")}</span>
            <input
              name="familyName"
              required
              maxLength={100}
              className={inputClass}
              data-testid="child-family"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("family.addChild.birthDate")}</span>
            <input
              type="date"
              name="birthDate"
              required
              className={inputClass}
              data-testid="child-birth"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("family.addChild.pin")}</span>
            <input name="personalIdentityNumber" maxLength={20} className={inputClass} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("family.addChild.pinCountry")}</span>
            <select name="pinCountry" className={inputClass} defaultValue="SE">
              <option value="SE">{t("family.addChild.countries.SE")}</option>
              <option value="NO">{t("family.addChild.countries.NO")}</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("family.addChild.iAm")}</span>
            <select name="kind" className={inputClass} defaultValue="parent">
              <option value="parent">{t("guardianKinds.parent")}</option>
              <option value="legal_guardian">{t("guardianKinds.legal_guardian")}</option>
            </select>
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className={buttonClass} data-testid="add-child-submit">
              {t("family.addChild.submit")}
            </button>
          </div>
        </ActionForm>
      </section>
    </div>
  );
}
