// SPDX-License-Identifier: AGPL-3.0-only
// Roles and permissions (P1.15 A2, ADR 0046): the club's roles as cards,
// with a sentence of what each allows, how many hold it and whether it is
// locked or sensitive; who may do what; roles administrators gave
// themselves; a new role. Read with club.roles.read, changed with
// club.roles.manage (and a second factor).
import { PersonName } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { AdministratorsBanner } from "../../../../../components/administrators-banner.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  isSensitive,
  permissionName,
  roleName,
  roleSummary,
} from "../../../../../components/roles.ts";
import {
  getAdministrators,
  getClub,
  getClubRoles,
  getMe,
  getMyClubs,
  getMyPermissions,
  getPermissionCatalogue,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("rolesAdmin.title") };
}

export default async function RolesPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, club, roles, mine, me, catalogue, my, administrators] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getClubRoles(clubId),
    getMyClubs(),
    getMe(),
    getPermissionCatalogue(),
    getMyPermissions(clubId),
    getAdministrators(clubId),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  const canManage = permissions.includes("club.roles.manage");
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const byId = new Map(roles.items.map((r) => [r.id, r]));
  const registrar = roles.items.find((r) => r.scope === "club" && r.templateKey === "registrar");
  const holdsRegistrar = registrar !== undefined && my.roleIds.includes(registrar.id);
  const rolePermissions = catalogue.items.filter((e) => e.kind === "role");

  const card = (r: (typeof roles.items)[number]) => (
    <li
      key={r.id}
      className="rounded-lg border border-border bg-raised p-4"
      data-testid="role-card"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <a href={`/clubs/${club.id}/roles/${r.id}`} className="font-semibold underline">
          {roleName(t, locale, r)}
        </a>
        {r.locked ? (
          <span className="rounded bg-accent-soft px-2 text-xs" title={t("rolesAdmin.lockedHint")}>
            {t("rolesAdmin.locked")}
          </span>
        ) : null}
        {r.permissions.some(isSensitive) ? (
          <span
            className="rounded bg-protected-soft px-2 text-xs"
            title={t("rolesAdmin.sensitiveHint")}
          >
            {t("rolesAdmin.sensitive")}
          </span>
        ) : null}
        <span className="ml-auto text-sm text-muted">
          {t("rolesAdmin.holders", { count: r.holderCount })}
        </span>
      </div>
      <p className="mt-1 text-sm">{roleSummary(t, r.permissions)}</p>
    </li>
  );

  return (
    <div className="space-y-8" data-testid="roles-page">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("rolesAdmin.title")}</h1>
        <p>{t("rolesAdmin.intro")}</p>
        <a href="/help/roles" className="text-sm text-accent underline">
          {t("rolesAdmin.helpLink")}
        </a>
      </div>
      <FormError code={query.error} />
      <AdministratorsBanner clubId={club.id} overview={administrators} />
      <a
        href={`/clubs/${club.id}/administrators`}
        className="text-sm text-accent underline"
        data-testid="administrators-link"
      >
        {t("administrators.title")}
      </a>
      {query.deleted ? <Notice>{t("rolesAdmin.deleted")}</Notice> : null}
      {query.role === "assigned" ? <Notice>{t("rolesAdmin.assigned")}</Notice> : null}

      {canManage && registrar && !holdsRegistrar ? (
        <div className="space-y-2 rounded-lg border border-border p-4" data-testid="manager-split">
          <p className="text-sm">
            {t("rolesAdmin.managerSplit", { role: roleName(t, locale, registrar) })}
          </p>
          <ActionForm action="assign-club-role">
            <input type="hidden" name="clubId" value={club.id} />
            <input type="hidden" name="personId" value={me.personId} />
            <input type="hidden" name="roleId" value={registrar.id} />
            <input type="hidden" name="back" value={`/clubs/${club.id}/roles`} />
            <button type="submit" className={secondaryButtonClass}>
              {t("rolesAdmin.giveMe", { role: roleName(t, locale, registrar) })}
            </button>
          </ActionForm>
        </div>
      ) : null}

      <section aria-labelledby="club-roles" className="space-y-2">
        <h2 id="club-roles" className="text-lg font-semibold">
          {t("rolesAdmin.clubRoles")}
        </h2>
        <p className="text-sm text-muted">{t("rolesAdmin.clubRolesHint")}</p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {roles.items.filter((r) => r.scope === "club").map(card)}
        </ul>
      </section>
      <section aria-labelledby="group-roles" className="space-y-2">
        <h2 id="group-roles" className="text-lg font-semibold">
          {t("rolesAdmin.groupRoles")}
        </h2>
        <p className="text-sm text-muted">{t("rolesAdmin.groupRolesHint")}</p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {roles.items.filter((r) => r.scope === "group").map(card)}
        </ul>
      </section>

      <section aria-labelledby="who-can" className="space-y-2">
        <h2 id="who-can" className="text-lg font-semibold">
          {t("rolesAdmin.whoCan")}
        </h2>
        <form
          method="get"
          action={`/clubs/${club.id}/roles/holders`}
          className="flex flex-wrap items-end gap-2"
        >
          <select
            name="permission"
            className={`${inputClass} max-w-md`}
            aria-label={t("rolesAdmin.whoCan")}
          >
            {rolePermissions.map((e) => (
              <option key={e.permission} value={e.permission}>
                {permissionName(t, e.permission)}
              </option>
            ))}
          </select>
          <button type="submit" className={secondaryButtonClass}>
            {t("rolesAdmin.whoCanButton")}
          </button>
        </form>
      </section>

      {roles.selfAssignments.length > 0 ? (
        <section aria-labelledby="self-assigned" className="space-y-2">
          <h2 id="self-assigned" className="text-lg font-semibold">
            {t("rolesAdmin.selfAssigned")}
          </h2>
          <p className="text-sm text-muted">{t("rolesAdmin.selfAssignedHint")}</p>
          <ul className="space-y-1" data-testid="self-assignments">
            {roles.selfAssignments.map((a) => {
              const role = byId.get(a.roleId);
              return (
                <li key={a.assignmentId} className="flex flex-wrap items-center gap-2">
                  <PersonName
                    person={a.person}
                    href={`/people/${a.person.id}?clubId=${club.id}`}
                    protectedLabel={t("protected.tooltip")}
                  />
                  <span className="text-sm text-muted">
                    {t("rolesAdmin.selfAssignedEntry", {
                      role: role ? roleName(t, locale, role) : "",
                      date: date.format(new Date(a.since)),
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {canManage ? (
        <section aria-labelledby="new-role" className="space-y-2">
          <h2 id="new-role" className="text-lg font-semibold">
            {t("rolesAdmin.newRole")}
          </h2>
          <p className="text-sm text-muted">{t("rolesAdmin.newRoleHint")}</p>
          <ActionForm action="create-role" className="grid max-w-xl gap-3">
            <input type="hidden" name="clubId" value={club.id} />
            <input type="hidden" name="back" value={`/clubs/${club.id}/roles`} />
            <label className="flex flex-col gap-1 text-sm">
              {t("rolesAdmin.scope")}
              <select name="scope" className={inputClass} defaultValue="group">
                <option value="group">{t("rolesAdmin.scopeGroup")}</option>
                <option value="club">{t("rolesAdmin.scopeClub")}</option>
              </select>
            </label>
            {(["nameSv", "nameEn", "nameNb"] as const).map((field) => (
              <label key={field} className="flex flex-col gap-1 text-sm">
                {t(`rolesAdmin.${field}`)}
                <input
                  name={field}
                  maxLength={60}
                  className={inputClass}
                  required={field === "nameSv"}
                />
              </label>
            ))}
            <button type="submit" className={buttonClass}>
              {t("rolesAdmin.create")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
