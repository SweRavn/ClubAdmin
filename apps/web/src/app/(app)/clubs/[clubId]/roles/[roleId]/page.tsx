// SPDX-License-Identifier: AGPL-3.0-only
// One role (P1.15 A2): its names and permissions, grouped by area with a
// sentence and an example each; sensitive ones marked; locked ones kept.
// Saving goes through a preview: the change in sentences and who loses
// what (names through the person presenter, others counted). Copy, reset
// to the template and delete (with a replacement) for administrators.
import { personLabel } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import {
  areaName,
  isSensitive,
  permissionDescription,
  permissionExample,
  permissionName,
  permissionsByArea,
  roleName,
} from "../../../../../../components/roles.ts";
import {
  getClub,
  getClubRoles,
  getMyClubs,
  getRolePreview,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; roleId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const all = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

export async function generateMetadata() {
  return { title: (await getTranslations())("rolesAdmin.title") };
}

export default async function RolePage({ params, searchParams }: Props) {
  const [{ clubId, roleId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, club, roles, mine] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getClubRoles(clubId),
    getMyClubs(),
  ]);
  const role = roles.items.find((r) => r.id === roleId);
  if (!role) notFound();
  const canManage = (mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? []).includes(
    "club.roles.manage",
  );
  const name = roleName(t, locale, role);
  const back = `/clubs/${club.id}/roles/${role.id}`;
  const areas = permissionsByArea(role.scope);
  const locked = new Set(role.lockedPermissions);

  // Step 2: the preview of a change (the form below was submitted with GET).
  const previewing = canManage && one(query.preview) === "1";
  const next = previewing
    ? [...new Set([...all(query.permission), ...role.lockedPermissions])]
    : role.permissions;
  const names = {
    nameSv: previewing ? one(query.nameSv) : (role.names?.sv ?? ""),
    nameEn: previewing ? one(query.nameEn) : (role.names?.en ?? ""),
    nameNb: previewing ? one(query.nameNb) : (role.names?.nb ?? ""),
  };
  const preview = previewing ? await getRolePreview(club.id, role.id, next) : null;
  const list = (ps: readonly string[]) => ps.map((p) => permissionName(t, p)).join(", ");

  return (
    <div className="space-y-8" data-testid="role-page">
      <div className="space-y-2">
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}/roles`} className="underline">
            {t("rolesAdmin.title")}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("rolesAdmin.editTitle", { name })}</h1>
        <p className="text-sm text-muted">
          {role.scope === "club" ? t("rolesAdmin.clubRolesHint") : t("rolesAdmin.groupRolesHint")}{" "}
          {t("rolesAdmin.holders", { count: role.holderCount })}
          {role.locked ? ` · ${t("rolesAdmin.lockedHint")}` : ""}
        </p>
        <a href="/help/roles" className="text-sm text-accent underline">
          {t("rolesAdmin.helpLink")}
        </a>
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("rolesAdmin.saved")}</Notice> : null}

      {previewing ? (
        <section
          aria-labelledby="preview"
          className="space-y-3 rounded-lg border border-border p-4"
          data-testid="role-preview"
        >
          <h2 id="preview" className="text-lg font-semibold">
            {t("rolesAdmin.previewTitle")}
          </h2>
          {preview === null ? (
            <p>{t("rolesAdmin.previewUnavailable")}</p>
          ) : (
            <>
              {preview.added.length > 0 ? (
                <p>{t("rolesAdmin.previewAdded", { list: list(preview.added) })}</p>
              ) : null}
              {preview.removed.length > 0 ? (
                <p>{t("rolesAdmin.previewRemoved", { list: list(preview.removed) })}</p>
              ) : null}
              {preview.added.length === 0 && preview.removed.length === 0 ? (
                <p>{t("rolesAdmin.previewNone")}</p>
              ) : null}
              <p className="text-sm text-muted">
                {t("rolesAdmin.previewHolders", { count: preview.holderCount })}
              </p>
              <ul className="space-y-1 text-sm">
                {preview.losing
                  .filter((l) => l.people.length + l.hiddenCount > 0)
                  .map((l) => (
                    <li key={l.permission}>
                      {t("rolesAdmin.previewLosing", {
                        count: l.people.length + l.hiddenCount,
                        permission: permissionName(t, l.permission),
                      })}{" "}
                      {l.people.map((p) => personLabel(p)).join(", ")}
                      {l.hiddenCount > 0
                        ? ` ${t("rolesAdmin.previewHidden", { count: l.hiddenCount })}`
                        : ""}
                    </li>
                  ))}
              </ul>
              <ActionForm action="update-role" className="flex flex-wrap gap-2">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="roleId" value={role.id} />
                <input type="hidden" name="version" value={String(role.version)} />
                <input type="hidden" name="back" value={back} />
                {Object.entries(names).map(([field, value]) => (
                  <input key={field} type="hidden" name={field} value={value} />
                ))}
                {next.map((p) => (
                  <input key={p} type="hidden" name="permission" value={p} />
                ))}
                <button type="submit" className={buttonClass}>
                  {t("rolesAdmin.save")}
                </button>
                <a href={back} className={secondaryButtonClass}>
                  {t("rolesAdmin.back")}
                </a>
              </ActionForm>
            </>
          )}
        </section>
      ) : null}

      <section aria-labelledby="reaches" className="space-y-2" data-testid="role-reaches">
        <h2 id="reaches" className="text-lg font-semibold">
          {t("rolesAdmin.reaches")}
        </h2>
        <p className="text-sm text-muted">{t("rolesAdmin.reachesHint")}</p>
        {role.permissions.length === 0 ? (
          <p>{t("rolesAdmin.noPermissions")}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {areas.flatMap((a) =>
              a.permissions
                .filter((p) => role.permissions.includes(p))
                .map((p) => (
                  <li key={p}>
                    <span className="font-medium">{permissionName(t, p)}</span>
                    {": "}
                    {permissionDescription(t, p)}
                  </li>
                )),
            )}
          </ul>
        )}
      </section>

      {canManage && !previewing ? (
        <form method="get" action={back} className="space-y-6" data-testid="role-form">
          <input type="hidden" name="preview" value="1" />
          <fieldset className="grid max-w-xl gap-3">
            <legend className="text-lg font-semibold">{t("rolesAdmin.names")}</legend>
            <p className="text-sm text-muted">{t("rolesAdmin.namesHint")}</p>
            {(["nameSv", "nameEn", "nameNb"] as const).map((field) => (
              <label key={field} className="flex flex-col gap-1 text-sm">
                {t(`rolesAdmin.${field}`)}
                <input
                  name={field}
                  defaultValue={names[field]}
                  maxLength={60}
                  className={inputClass}
                />
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-4">
            <legend className="text-lg font-semibold">{t("rolesAdmin.permissionsTitle")}</legend>
            <p className="text-sm text-muted">{t("rolesAdmin.permissionsHint")}</p>
            {areas.map((a) => (
              <div key={a.area} className="space-y-2">
                <h3 className="font-medium">{areaName(t, a.area)}</h3>
                <ul className="space-y-2">
                  {a.permissions.map((p) => (
                    <li key={p}>
                      <label className="flex gap-2">
                        <input
                          type="checkbox"
                          name="permission"
                          value={p}
                          defaultChecked={role.permissions.includes(p)}
                          disabled={locked.has(p)}
                          className="mt-1"
                        />
                        <span>
                          <span className="font-medium">{permissionName(t, p)}</span>
                          {locked.has(p) ? (
                            <span className="ml-2 rounded bg-accent-soft px-2 text-xs">
                              {t("rolesAdmin.locked")}
                            </span>
                          ) : null}
                          {isSensitive(p) ? (
                            <span
                              className="ml-2 rounded bg-protected-soft px-2 text-xs"
                              title={t("rolesAdmin.sensitiveHint")}
                            >
                              {t("rolesAdmin.sensitive")}
                            </span>
                          ) : null}
                          <span className="block text-sm">{permissionDescription(t, p)}</span>
                          <span className="block text-sm text-muted">
                            {t("rolesAdmin.example", { text: permissionExample(t, p) })}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </fieldset>
          <button type="submit" className={buttonClass}>
            {t("rolesAdmin.preview")}
          </button>
        </form>
      ) : null}

      {canManage && !previewing ? (
        <section className="flex flex-wrap gap-4" aria-label={t("rolesAdmin.title")}>
          <ActionForm action="create-role">
            <input type="hidden" name="clubId" value={club.id} />
            <input type="hidden" name="scope" value={role.scope} />
            <input type="hidden" name="nameSv" value={t("rolesAdmin.copyName", { name })} />
            <input type="hidden" name="back" value={back} />
            {role.permissions.map((p) => (
              <input key={p} type="hidden" name="permission" value={p} />
            ))}
            <button type="submit" className={secondaryButtonClass}>
              {t("rolesAdmin.copy")}
            </button>
          </ActionForm>
          {role.templateKey && role.differsFromTemplate ? (
            <ActionForm action="update-role">
              <input type="hidden" name="clubId" value={club.id} />
              <input type="hidden" name="roleId" value={role.id} />
              <input type="hidden" name="version" value={String(role.version)} />
              <input type="hidden" name="reset" value="1" />
              <input type="hidden" name="back" value={back} />
              <button
                type="submit"
                className={secondaryButtonClass}
                title={t("rolesAdmin.resetHint")}
              >
                {t("rolesAdmin.reset")}
              </button>
            </ActionForm>
          ) : null}
          {!role.locked ? (
            <ActionForm action="delete-role" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="clubId" value={club.id} />
              <input type="hidden" name="roleId" value={role.id} />
              <input type="hidden" name="back" value={back} />
              <span className="text-sm text-muted">
                {t("rolesAdmin.deleteHint", { count: role.holderCount })}
              </span>
              {role.holderCount > 0 ? (
                <label className="flex flex-col gap-1 text-sm">
                  {t("rolesAdmin.replacement")}
                  <select name="replacementRoleId" className={inputClass} defaultValue="">
                    <option value="">{t("rolesAdmin.noReplacement")}</option>
                    {roles.items
                      .filter((r) => r.scope === role.scope && r.id !== role.id)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {roleName(t, locale, r)}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              <button type="submit" className={secondaryButtonClass}>
                {t("rolesAdmin.delete")}
              </button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
