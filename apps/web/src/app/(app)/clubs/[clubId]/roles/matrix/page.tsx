// SPDX-License-Identifier: AGPL-3.0-only
// The role matrix (P2.7c): people in rows, the club's roles in columns. A
// cell gives or ends the role with one tap (in place, ADR 0055), for those
// who may change roles; others read it. Rows are the people who hold a club
// role, a page at a time, plus people added by searching the register; a
// role filter narrows the rows. Group roles are given in each group's
// administration (a membership with a role), linked from here.
import { personLabel } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import { LiveSearch, SubmitWithoutScript } from "../../../../../../components/live-search.tsx";
import { RoleMatrixKeys } from "../../../../../../components/role-matrix-keys.tsx";
import { roleName } from "../../../../../../components/roles.ts";
import {
  getClub,
  getClubRoles,
  getMyClubs,
  getRegister,
  getRoleMatrix,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export async function generateMetadata() {
  return { title: (await getTranslations())("roleMatrix.title") };
}

export default async function RoleMatrixPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const include = one(query.include).split(",").filter(Boolean).slice(0, 20);
  const roleFilter = one(query.roleId);
  const add = one(query.add).trim().slice(0, 100);
  const cursor = one(query.cursor);
  const [t, locale, club, roles, mine, matrix, matches] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getClubRoles(clubId),
    getMyClubs(),
    getRoleMatrix(clubId, {
      ...(cursor ? { cursor } : {}),
      ...(roleFilter ? { roleId: roleFilter } : {}),
      include,
    }),
    add.length >= 2
      ? getRegister(clubId, new URLSearchParams({ q: add, limit: "10" }).toString())
      : null,
  ]);
  const permissions: readonly string[] =
    mine.clubs.find((c) => c.club.id === clubId)?.permissions ?? [];
  const canManage = permissions.includes("club.roles.manage");
  const clubRoles = roles.items.filter((r) => r.scope === "club");
  const base = `/clubs/${clubId}/roles/matrix`;
  const link = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const values: Record<string, string | null> = {
      roleId: roleFilter || null,
      include: include.join(",") || null,
      ...changes,
    };
    for (const [key, value] of Object.entries(values)) if (value) next.set(key, value);
    const qs = next.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const shownIds = new Set(matrix.rows.map((r) => r.person.id));

  return (
    <div className="space-y-6" data-testid="role-matrix-page">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("roleMatrix.title")}</h1>
        <p className="text-muted">
          {canManage ? t("roleMatrix.introManage") : t("roleMatrix.introRead")}
        </p>
      </div>
      <FormError code={query.error} />
      {query.role === "assigned" ? <Notice>{t("rolesAdmin.assigned")}</Notice> : null}
      {query.role === "ended" ? <Notice>{t("roleMatrix.ended")}</Notice> : null}

      <div className="flex flex-wrap items-end gap-4">
        {/* The role filter. */}
        <form method="get" action={base} className="flex flex-wrap items-end gap-2">
          {include.length > 0 ? (
            <input type="hidden" name="include" value={include.join(",")} />
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            {t("roleMatrix.filterRole")}
            <select
              name="roleId"
              defaultValue={roleFilter}
              className={inputClass}
              data-testid="role-matrix-filter"
            >
              <option value="">{t("roleMatrix.allRoles")}</option>
              {clubRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleName(t, locale, r)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={secondaryButtonClass}>
            {t("roleMatrix.filter")}
          </button>
        </form>
        {/* Someone without a role yet: search the register, add the row. */}
        {canManage ? (
          <form method="get" action={base} className="flex flex-wrap items-end gap-2">
            {roleFilter ? <input type="hidden" name="roleId" value={roleFilter} /> : null}
            {include.length > 0 ? (
              <input type="hidden" name="include" value={include.join(",")} />
            ) : null}
            <label className="flex flex-col gap-1 text-sm">
              {t("roleMatrix.addPerson")}
              <LiveSearch
                name="add"
                defaultValue={add}
                label={t("roleMatrix.addPerson")}
                className={inputClass}
                resultsId="role-matrix-matches"
                testId="role-matrix-search"
              />
            </label>
            <SubmitWithoutScript>
              <button type="submit" className={secondaryButtonClass}>
                {t("roleMatrix.search")}
              </button>
            </SubmitWithoutScript>
          </form>
        ) : null}
      </div>
      {matches ? (
        <ul id="role-matrix-matches" className="space-y-1 rounded-md border border-border p-2">
          {matches.items.length === 0 ? (
            <li className="text-sm text-muted">{t("roleMatrix.noMatches")}</li>
          ) : (
            matches.items.slice(0, 10).map((m) => (
              <li key={m.person.id}>
                {shownIds.has(m.person.id) ? (
                  <span className="text-sm">
                    {personLabel(m.person)} ({t("roleMatrix.inTable")})
                  </span>
                ) : (
                  <a
                    href={link({ include: [...include, m.person.id].join(","), add: null })}
                    className="text-accent underline"
                    data-testid="role-matrix-add"
                  >
                    {t("roleMatrix.addRow", { name: personLabel(m.person) })}
                  </a>
                )}
              </li>
            ))
          )}
        </ul>
      ) : null}

      {matrix.rows.length === 0 ? (
        <p className="text-muted" data-testid="role-matrix-empty">
          {t("roleMatrix.empty")}
        </p>
      ) : (
        <RoleMatrixKeys>
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
            <table className="border-separate border-spacing-0 text-sm" data-testid="role-matrix">
              <caption className="sr-only">{t("roleMatrix.title")}</caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="sticky top-0 left-0 z-20 bg-raised px-3 py-2 text-left"
                  >
                    {t("roleMatrix.person")}
                  </th>
                  {clubRoles.map((r) => (
                    <th
                      key={r.id}
                      scope="col"
                      className="sticky top-0 z-10 bg-raised px-2 py-2 text-left font-medium"
                    >
                      <a href={`/clubs/${clubId}/roles/${r.id}`} className="underline">
                        {roleName(t, locale, r)}
                      </a>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row, rowIndex) => {
                  const name = personLabel(row.person);
                  return (
                    <tr
                      key={row.person.id}
                      data-testid="role-matrix-row"
                      data-person={row.person.id}
                    >
                      <th
                        scope="row"
                        className="sticky left-0 z-10 border-t border-border bg-raised px-3 py-1 text-left font-normal"
                      >
                        <a href={`/people/${row.person.id}?clubId=${clubId}`} className="underline">
                          {name}
                        </a>
                      </th>
                      {clubRoles.map((role, colIndex) => {
                        const assignment = row.assignments.find((a) => a.roleId === role.id);
                        const holds = assignment !== undefined;
                        const label = t(holds ? "roleMatrix.cellHolds" : "roleMatrix.cellNot", {
                          name,
                          role: roleName(t, locale, role),
                        });
                        const mark = <span aria-hidden="true">{holds ? "✓" : ""}</span>;
                        const cellClass = `flex h-8 w-10 items-center justify-center rounded ${
                          holds ? "bg-accent-soft font-semibold" : ""
                        }`;
                        return (
                          <td
                            key={role.id}
                            className="border-t border-border px-2 py-1 text-center"
                          >
                            {canManage ? (
                              <ActionForm
                                action={holds ? "unassign-club-role" : "assign-club-role"}
                              >
                                <input type="hidden" name="clubId" value={clubId} />
                                <input type="hidden" name="personId" value={row.person.id} />
                                <input type="hidden" name="roleId" value={role.id} />
                                {assignment ? (
                                  <input type="hidden" name="assignmentId" value={assignment.id} />
                                ) : null}
                                <button
                                  type="submit"
                                  aria-pressed={holds}
                                  aria-label={label}
                                  title={label}
                                  className={`${cellClass} border border-border hover:bg-surface`}
                                  data-cell={`${rowIndex}:${colIndex}`}
                                  data-testid="role-matrix-cell"
                                  data-role={role.id}
                                >
                                  {mark}
                                </button>
                              </ActionForm>
                            ) : (
                              <span
                                className={cellClass}
                                role="img"
                                aria-label={label}
                                data-testid="role-matrix-cell"
                                data-role={role.id}
                              >
                                {mark}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </RoleMatrixKeys>
      )}
      {matrix.nextCursor ? (
        <a
          href={link({ cursor: matrix.nextCursor, include: null })}
          className="text-sm underline"
          data-testid="role-matrix-next"
        >
          {t("roleMatrix.next")}
        </a>
      ) : null}
      <p className="text-sm text-muted">
        {t("roleMatrix.groupRoles", { club: club.name })}{" "}
        <a href={`/clubs/${clubId}/groups`} className="underline">
          {t("nav.groups")}
        </a>
      </p>
    </div>
  );
}
