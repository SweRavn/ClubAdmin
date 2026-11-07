// SPDX-License-Identifier: AGPL-3.0-only
// Running a group (P1.10a): its places today and per season, its owners and
// its members with their functions. Club managers and owners (also of a
// parent group); co-owners only where the club allows it. Searching is a GET
// form and every change a server action, so the page works without
// JavaScript.
import { enumKey } from "@clubadmin/i18n";
import { GROUP_FUNCTIONS } from "@clubadmin/shared";
import { personLabel, PersonName } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getClubSeasons,
  getGroup,
  getGroupCandidates,
  getGroupMembers,
  getGroupSeasons,
  getMyClubs,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (value: string | string[] | undefined, max = 100) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export async function generateMetadata() {
  return { title: (await getTranslations())("groupAdmin.title") };
}

export default async function ManageGroupPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const [t, group, mine] = await Promise.all([getTranslations(), getGroup(groupId), getMyClubs()]);
  if (!group.canManage && !group.canManageMembers && !group.canManageOwners) forbidden();
  const isManager =
    mine.clubs
      .find((c) => c.club.id === group.clubId)
      ?.permissions.includes("club.settings.update") ?? false;
  const ownerQ = one(query.ownerQ);
  const memberQ = one(query.memberQ);
  const fnParam = one(query.function);
  const fn = (GROUP_FUNCTIONS as readonly string[]).includes(fnParam) ? fnParam : "member";
  const [members, seasons, groupSeasons, ownerMatches, memberMatches] = await Promise.all([
    getGroupMembers(group.id, 200),
    group.canManage && !group.archived ? getClubSeasons(group.clubId) : null,
    group.canManage && !group.archived ? getGroupSeasons(group.id) : null,
    group.canManageOwners && !group.archived && ownerQ.length >= 2
      ? getGroupCandidates(group.id, ownerQ, null)
      : null,
    group.canManageMembers && !group.archived && memberQ.length >= 2
      ? getGroupCandidates(group.id, memberQ, fn)
      : null,
  ]);
  const protectedLabel = t("protected.tooltip");
  const full =
    group.effectiveCapacity !== undefined &&
    group.effectiveCapacity !== null &&
    (group.occupied ?? 0) >= group.effectiveCapacity;
  const seasonCapacity = new Map(
    (groupSeasons?.items ?? []).map((s) => [s.seasonId, s.capacity] as const),
  );
  const fnLabel = (f: string) => t(enumKey("functions", f));
  const candidateLine = (c: {
    person: { id: string } & Parameters<typeof personLabel>[0];
    birthYear: number | null;
    memberNumber: number | null;
  }) =>
    [
      personLabel(c.person),
      c.birthYear !== null ? t("groupAdmin.born", { year: String(c.birthYear) }) : null,
      c.memberNumber !== null ? t("groupAdmin.memberNumber", { number: c.memberNumber }) : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="space-y-8" data-testid="group-manage">
      <div className="space-y-2">
        <p className="text-sm text-muted">
          <a href={`/groups/${group.id}`} className="underline">
            {group.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("groupAdmin.title")}</h1>
        <FormError code={query.error} />
        {query.owner === "added" ? <Notice>{t("groupAdmin.ownerAdded")}</Notice> : null}
        {query.owner === "removed" ? <Notice>{t("groupAdmin.ownerRemoved")}</Notice> : null}
        {query.member === "added" ? <Notice>{t("groupAdmin.memberAdded")}</Notice> : null}
        {query.member === "ended" ? <Notice>{t("groupAdmin.membershipEnded")}</Notice> : null}
        {query.season === "saved" ? <Notice>{t("groupAdmin.seasonSaved")}</Notice> : null}
        {query.season === "created" ? <Notice>{t("groupAdmin.seasonCreated")}</Notice> : null}
        {group.archived ? (
          <p className="rounded-md bg-notice px-3 py-2 text-notice-fg">
            {t("groupForm.archivedHint")}
          </p>
        ) : null}
        {group.occupied !== undefined ? (
          <p data-testid="group-places">
            {group.effectiveCapacity === null || group.effectiveCapacity === undefined
              ? t("groupAdmin.placesUnlimited", { occupied: group.occupied })
              : t("groupAdmin.places", {
                  occupied: group.occupied,
                  capacity: group.effectiveCapacity,
                })}
            {full ? ` ${t("groupAdmin.full")}` : ""}
          </p>
        ) : null}
      </div>

      <section className="space-y-3" data-testid="group-owners">
        <h2 className="text-lg font-semibold">{t("groupAdmin.ownersTitle")}</h2>
        {group.owners.length === 0 ? (
          <p className="text-sm text-muted">{t("groupAdmin.ownersEmpty")}</p>
        ) : (
          <ul className="space-y-2">
            {group.owners.map((owner) => (
              <li key={owner.id} className="flex flex-wrap items-center gap-3">
                <PersonName person={owner} protectedLabel={protectedLabel} />
                {group.canManageOwners && !group.archived ? (
                  <ActionForm action="remove-group-owner">
                    <input type="hidden" name="groupId" value={group.id} />
                    <input type="hidden" name="personId" value={owner.id} />
                    <button
                      type="submit"
                      className={secondaryButtonClass}
                      data-testid="remove-owner"
                    >
                      {t("groupAdmin.removeOwner")}
                    </button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {group.canManageOwners && !group.archived ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <h3 className="font-medium">{t("groupAdmin.addOwnerTitle")}</h3>
            <p className="text-sm text-muted">{t("groupAdmin.ownerHint")}</p>
            <form method="get" className="flex flex-wrap gap-2">
              <input
                name="ownerQ"
                defaultValue={ownerQ}
                minLength={2}
                className={`${inputClass} max-w-xs`}
                aria-label={t("groupAdmin.search")}
                placeholder={t("groupAdmin.search")}
                data-testid="owner-search"
              />
              <button type="submit" className={secondaryButtonClass}>
                {t("groupAdmin.searchButton")}
              </button>
            </form>
            {ownerMatches ? (
              ownerMatches.items.length === 0 ? (
                <p className="text-sm text-muted">{t("groupAdmin.noMatches")}</p>
              ) : (
                <ul className="space-y-1">
                  {ownerMatches.items.map((c) => (
                    <li key={c.person.id} className="flex flex-wrap items-center gap-3">
                      <span>{candidateLine(c)}</span>
                      <ActionForm action="add-group-owner">
                        <input type="hidden" name="groupId" value={group.id} />
                        <input type="hidden" name="personId" value={c.person.id} />
                        <button
                          type="submit"
                          className={secondaryButtonClass}
                          data-testid="make-owner"
                        >
                          {t("groupAdmin.makeOwner")}
                        </button>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="space-y-3" data-testid="group-members-admin">
        <h2 className="text-lg font-semibold">{t("groupAdmin.membersTitle")}</h2>
        {!members || members.items.length === 0 ? (
          <p className="text-sm text-muted">{t("groupAdmin.membersEmpty")}</p>
        ) : (
          <ul className="space-y-2">
            {members.items.map((m) => (
              <li key={m.person.id} className="flex flex-wrap items-center gap-3">
                <PersonName person={m.person} protectedLabel={protectedLabel} />
                {(m.memberships ?? m.functions.map((f) => ({ id: null, function: f }))).map(
                  (ms) => (
                    <span key={`${m.person.id}-${ms.function}`} className="flex items-center gap-1">
                      <span className="text-sm text-muted">{fnLabel(ms.function)}</span>
                      {ms.id && group.canManageMembers && !group.archived ? (
                        <ActionForm action="end-group-membership">
                          <input type="hidden" name="groupId" value={group.id} />
                          <input type="hidden" name="membershipId" value={ms.id} />
                          <button
                            type="submit"
                            className="text-sm text-accent underline"
                            data-testid="end-membership"
                          >
                            {t("groupAdmin.end")}
                          </button>
                        </ActionForm>
                      ) : null}
                    </span>
                  ),
                )}
              </li>
            ))}
          </ul>
        )}
        {group.canManageMembers && !group.archived ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <h3 className="font-medium">{t("groupAdmin.addMemberTitle")}</h3>
            <form method="get" className="flex flex-wrap gap-2">
              <input
                name="memberQ"
                defaultValue={memberQ}
                minLength={2}
                className={`${inputClass} max-w-xs`}
                aria-label={t("groupAdmin.search")}
                placeholder={t("groupAdmin.search")}
                data-testid="member-search"
              />
              <label className="flex items-center gap-2 text-sm">
                {t("groupAdmin.function")}
                <select name="function" defaultValue={fn} className={inputClass}>
                  {GROUP_FUNCTIONS.map((f) => (
                    <option key={f} value={f}>
                      {fnLabel(f)}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={secondaryButtonClass}>
                {t("groupAdmin.searchButton")}
              </button>
            </form>
            {memberMatches ? (
              memberMatches.items.length === 0 ? (
                <p className="text-sm text-muted">{t("groupAdmin.noMatches")}</p>
              ) : (
                <ul className="space-y-1">
                  {memberMatches.items.map((c) => (
                    <li key={c.person.id}>
                      <ActionForm
                        action="add-group-member"
                        className="flex flex-wrap items-center gap-3"
                      >
                        <input type="hidden" name="groupId" value={group.id} />
                        <input type="hidden" name="personId" value={c.person.id} />
                        <input type="hidden" name="function" value={fn} />
                        <span>{candidateLine(c)}</span>
                        {full && fn === "member" ? (
                          <label className="flex items-center gap-1 text-sm">
                            <input type="checkbox" name="overCapacity" />
                            {t("groupAdmin.overCapacity")}
                          </label>
                        ) : null}
                        {fn === "member" && (group.waitingCount ?? 0) > 0 ? (
                          <label className="flex flex-col gap-1 text-sm">
                            {t("waitlist.queueBypassReason", { count: group.waitingCount ?? 0 })}
                            <input
                              name="queueBypassReason"
                              required
                              maxLength={500}
                              className={inputClass}
                              data-testid="queue-bypass-reason"
                            />
                          </label>
                        ) : null}
                        <button
                          type="submit"
                          className={secondaryButtonClass}
                          data-testid="add-member"
                        >
                          {t("groupAdmin.add")}
                        </button>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        ) : null}
      </section>

      {seasons ? (
        <section className="space-y-3" data-testid="group-seasons">
          <h2 className="text-lg font-semibold">{t("groupAdmin.seasonsTitle")}</h2>
          {seasons.items.length === 0 ? (
            <p className="text-sm text-muted">{t("groupAdmin.seasonsEmpty")}</p>
          ) : (
            <ul className="space-y-2">
              {seasons.items.map((season) => (
                <li key={season.id}>
                  <ActionForm action="set-group-season" className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="groupId" value={group.id} />
                    <input type="hidden" name="seasonId" value={season.id} />
                    <span className="min-w-40">
                      {season.name}{" "}
                      <span className="text-sm text-muted">
                        {season.startsOn} – {season.endsOn}
                      </span>
                    </span>
                    <label className="space-y-1 text-sm">
                      <span>{t("groupAdmin.seasonCapacity")}</span>
                      <input
                        type="number"
                        name="capacity"
                        min={1}
                        max={10000}
                        defaultValue={seasonCapacity.get(season.id) ?? ""}
                        className={`${inputClass} w-28`}
                        title={t("groupAdmin.seasonCapacityHint")}
                      />
                    </label>
                    <button type="submit" className={secondaryButtonClass}>
                      {t("groupAdmin.saveSeason")}
                    </button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted">{t("groupAdmin.seasonCapacityHint")}</p>
          {isManager ? (
            <ActionForm
              action="create-season"
              className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3"
            >
              <input type="hidden" name="clubId" value={group.clubId} />
              <span className="w-full font-medium">{t("groupAdmin.newSeason")}</span>
              <label className="space-y-1 text-sm">
                <span>{t("groupAdmin.seasonName")}</span>
                <input name="name" required maxLength={50} className={inputClass} />
              </label>
              <label className="space-y-1 text-sm">
                <span>{t("groupAdmin.seasonStart")}</span>
                <input type="date" name="startsOn" required className={inputClass} />
              </label>
              <label className="space-y-1 text-sm">
                <span>{t("groupAdmin.seasonEnd")}</span>
                <input type="date" name="endsOn" required className={inputClass} />
              </label>
              <button type="submit" className={buttonClass}>
                {t("groupAdmin.createSeason")}
              </button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
