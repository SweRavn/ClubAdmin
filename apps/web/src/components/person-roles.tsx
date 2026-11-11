// SPDX-License-Identifier: AGPL-3.0-only
// A member's club roles on their profile (P1.15 A2): what they hold, ended
// by those who administer roles, and a role to give. Group roles are given
// in the group's member list.
import { getLocale, getTranslations } from "next-intl/server";

import { getClubRoles, getRoleAssignments } from "../server/data.ts";
import { ActionForm, inputClass, secondaryButtonClass } from "./action-form.tsx";
import { roleName } from "./roles.ts";

export async function PersonClubRoles({
  clubId,
  personId,
  canManage,
  back,
}: {
  clubId: string;
  personId: string;
  canManage: boolean;
  back: string;
}) {
  const [t, locale, assignments, roles] = await Promise.all([
    getTranslations(),
    getLocale(),
    getRoleAssignments(clubId, personId),
    getClubRoles(clubId),
  ]);
  if (!assignments) return null;
  const byId = new Map(roles.items.map((r) => [r.id, r]));
  const held = new Set(assignments.items.map((a) => a.roleId));
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  return (
    <section aria-labelledby="person-roles" className="space-y-2" data-testid="person-roles">
      <h2 id="person-roles" className="text-lg font-semibold">
        {t("rolesAdmin.personRoles")}
      </h2>
      {assignments.items.length === 0 ? (
        <p className="text-sm text-muted">{t("rolesAdmin.personNoRoles")}</p>
      ) : (
        <ul className="space-y-1">
          {assignments.items.map((a) => {
            const role = byId.get(a.roleId);
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <a href={`/clubs/${clubId}/roles/${a.roleId}`} className="underline">
                  {role ? roleName(t, locale, role) : ""}
                </a>
                <span className="text-sm text-muted">
                  {date.format(new Date(a.validFrom))}
                  {a.self ? ` · ${t("rolesAdmin.selfMark")}` : ""}
                </span>
                {canManage && !role?.locked ? (
                  <ActionForm action="unassign-club-role">
                    <input type="hidden" name="clubId" value={clubId} />
                    <input type="hidden" name="assignmentId" value={a.id} />
                    <input type="hidden" name="back" value={back} />
                    <button type="submit" className={secondaryButtonClass}>
                      {t("rolesAdmin.end")}
                    </button>
                  </ActionForm>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canManage ? (
        <ActionForm action="assign-club-role" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="clubId" value={clubId} />
          <input type="hidden" name="personId" value={personId} />
          <input type="hidden" name="back" value={back} />
          <label className="flex flex-col gap-1 text-sm">
            {t("rolesAdmin.giveRole")}
            <select name="roleId" className={inputClass}>
              {roles.items
                .filter(
                  (r) => r.scope === "club" && !held.has(r.id) && r.templateKey !== "club_manager",
                )
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleName(t, locale, r)}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" className={secondaryButtonClass}>
            {t("rolesAdmin.giveRole")}
          </button>
        </ActionForm>
      ) : null}
    </section>
  );
}
