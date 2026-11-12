// SPDX-License-Identifier: AGPL-3.0-only
// The club's invitations (club managers and registrars, P1.1; group owners
// for their own groups, P1.15 A4): create by email, link or code, to several
// groups each with a group role, optionally with a club role; the link or
// code is shown once, right after creation.
import { enumKey } from "@clubadmin/i18n";
import { GROUP_KINDS } from "@clubadmin/shared";
import { EmptyState, personLabel } from "@clubadmin/ui";
import { cookies } from "next/headers";
import { forbidden } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { InvitationGroupPicker } from "../../../../../components/invitation-group-picker.tsx";
import { roleName } from "../../../../../components/roles.ts";
import { INVITATION_SECRET_COOKIE } from "../../../../../server/cookies.ts";
import {
  getClub,
  getClubGroups,
  getClubInvitations,
  getInvitationOptions,
  getMyClubs,
  requireSession,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("invitations.title") };
}

export default async function InvitationsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, club, mine, session, jar] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getMyClubs(),
    requireSession(),
    cookies(),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.invitations.manage")) forbidden();
  const [invitations, groups, options] = await Promise.all([
    getClubInvitations(club.id),
    getClubGroups(club.id),
    getInvitationOptions(club.id),
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const roleLabel = new Map([
    ...options.groupRoles.map(
      (r) => [r.id, roleName(t, locale, { ...r, scope: "group" })] as const,
    ),
    ...options.clubRoles.map((r) => [r.id, roleName(t, locale, { ...r, scope: "club" })] as const),
  ]);
  const secret = query.created ? (jar.get(INVITATION_SECRET_COOKIE)?.value ?? null) : null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("invitations.title")}</h1>
      <FormError code={query.error} />
      {query.sent ? <Notice>{t("invitations.sent")}</Notice> : null}
      {secret ? (
        <div
          className="space-y-2 rounded-lg border border-accent bg-accent-soft p-4"
          data-testid="invitation-secret"
        >
          <p>{t("invitations.created")}</p>
          <output
            className="block break-all rounded-md bg-bg px-3 py-2 font-mono"
            data-testid="invitation-value"
          >
            {secret}
          </output>
        </div>
      ) : null}

      <section
        aria-labelledby="new-invitation"
        className="rounded-lg border border-border bg-raised p-4"
      >
        <h2 id="new-invitation" className="mb-3 text-lg font-semibold">
          {t("invitations.create")}
        </h2>
        <form
          method="post"
          action="/actions/create-invitation"
          className="grid gap-3 sm:grid-cols-2"
          data-testid="invitation-form"
        >
          <input type="hidden" name="csrf" value={session.record.csrf} />
          <input type="hidden" name="clubId" value={club.id} />
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t("invitations.kind")}</span>
            <select name="kind" className={inputClass} defaultValue="link">
              {(["link", "code", "email"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(enumKey("invitationKinds", k))}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t("invitations.email")}</span>
            <input type="email" name="email" autoComplete="off" className={inputClass} />
          </label>
          <InvitationGroupPicker
            groups={options.groups.map((g) => ({
              id: g.id,
              name: g.name,
              kind: g.kind,
              kindLabel: t(enumKey("kinds", g.kind)),
              own: g.own,
              roles: g.roleIds.map((id) => ({ id, label: roleLabel.get(id) ?? "" })),
            }))}
            kinds={GROUP_KINDS.map((k) => ({ value: k, label: t(enumKey("kinds", k)) }))}
            labels={{
              legend: t("invitations.groups"),
              hint: options.clubWide
                ? t("invitations.groupsHint")
                : t("invitations.groupsOwnerHint"),
              filter: t("invitations.groupsFilter"),
              allKinds: t("invitations.allKinds"),
              role: t("invitations.groupRole"),
              own: t("invitations.ownGroup"),
              none: t("invitations.noGroups"),
              chosen: t("invitations.chosen"),
            }}
          />
          {options.clubRoles.length > 0 ? (
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t("invitations.role")}</span>
              <select name="clubRoleId" className={inputClass} defaultValue="">
                <option value="">{t("invitations.noRole")}</option>
                {options.clubRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleLabel.get(r.id)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t("invitations.maxUses")}</span>
            <input type="number" name="maxUses" min={1} max={1000} className={inputClass} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t("invitations.expiresInDays")}</span>
            <input
              type="number"
              name="expiresInDays"
              min={1}
              max={90}
              defaultValue={14}
              className={inputClass}
            />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className={buttonClass} data-testid="create-invitation">
              {t("invitations.submit")}
            </button>
          </div>
        </form>
      </section>

      {invitations.items.length === 0 ? (
        <EmptyState title={t("invitations.empty")} headingLevel={2} />
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border bg-raised"
          data-testid="invitations"
        >
          {invitations.items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="font-medium">{t(enumKey("invitationKinds", i.kind))}</span>
              {i.email ? <span>{i.email}</span> : null}
              <span className="text-sm text-muted">{t(enumKey("invitationStates", i.state))}</span>
              <span className="text-sm text-muted">
                {i.maxUses === null
                  ? t("invitations.usesUnlimited", { uses: i.uses })
                  : t("invitations.uses", { uses: i.uses, max: i.maxUses })}
              </span>
              <span className="text-sm text-muted">
                {t("invitations.expires", { date: date.format(new Date(i.expiresAt)) })}
              </span>
              {i.groups.length > 0 || i.clubRoleId ? (
                <span className="basis-full text-sm" data-testid="invitation-gives">
                  {[
                    ...i.groups.map((g) =>
                      t("invitations.groupAs", {
                        group: groupName.get(g.groupId) ?? t("invitations.unknownGroup"),
                        role: roleLabel.get(g.roleId) ?? "",
                      }),
                    ),
                    ...(i.clubRoleId && roleLabel.has(i.clubRoleId)
                      ? [roleLabel.get(i.clubRoleId)!]
                      : []),
                  ].join(" · ")}
                </span>
              ) : null}
              {i.createdBy ? (
                <span className="text-sm text-muted">
                  {t("invitations.createdBy", { name: personLabel(i.createdBy) })}
                </span>
              ) : null}
              {i.state === "active" ? (
                <ActionForm action="revoke-invitation" className="ml-auto">
                  <input type="hidden" name="clubId" value={club.id} />
                  <input type="hidden" name="invitationId" value={i.id} />
                  <button type="submit" className={secondaryButtonClass}>
                    {t("invitations.revoke")}
                  </button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
