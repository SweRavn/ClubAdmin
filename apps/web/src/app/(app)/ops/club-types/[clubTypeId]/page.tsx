// SPDX-License-Identifier: AGPL-3.0-only
// One club type (P1.15 B, operators): its names, the one sentence, whether
// clubs can choose it, and its template's roles with the same permission
// picker as the clubs' role editor (A2.4). The roles every type needs keep
// their required permissions and cannot be removed. Templates never change
// existing clubs (decision 6).
import { REQUIRED_TEMPLATE_ROLES } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  areaName,
  isSensitive,
  permissionName,
  permissionsByArea,
  roleName,
} from "../../../../../components/roles.ts";
import { getOpsClubType } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubTypeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("clubTypes.title") };
}

const NAME_FIELDS = [
  ["nameSv", "sv"],
  ["nameEn", "en"],
  ["nameNb", "nb"],
] as const;
const DESCRIPTION_FIELDS = [
  ["descriptionSv", "sv"],
  ["descriptionEn", "en"],
  ["descriptionNb", "nb"],
] as const;

export default async function ClubTypePage({ params, searchParams }: Props) {
  const [{ clubTypeId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, type] = await Promise.all([
    getTranslations(),
    getLocale(),
    getOpsClubType(clubTypeId),
  ]);
  const lang = (texts: Record<string, string | undefined> | null) =>
    texts?.[locale.slice(0, 2)] ?? texts?.sv ?? "";
  const requiredOf = (r: { scope: string; key: string }) =>
    REQUIRED_TEMPLATE_ROLES.find((x) => x.scope === r.scope && x.key === r.key)?.permissions ?? [];

  return (
    <div className="space-y-8" data-testid="club-type-page">
      <div className="space-y-1">
        <a href="/ops/club-types" className="text-sm underline">
          {t("clubTypes.title")}
        </a>
        <h1 className="text-2xl font-semibold">{lang(type.names)}</h1>
        <p className="text-sm text-muted">{t("clubTypes.decision6")}</p>
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("clubTypes.saved")}</Notice> : null}

      <section aria-labelledby="type" className="space-y-2">
        <h2 id="type" className="text-lg font-semibold">
          {t("clubTypes.type")}
        </h2>
        <ActionForm action="ops-update-club-type" className="grid max-w-xl gap-3">
          <input type="hidden" name="clubTypeId" value={type.id} />
          {NAME_FIELDS.map(([field, l]) => (
            <label key={field} className="flex flex-col gap-1 text-sm">
              {t(`rolesAdmin.${field}`)}
              <input
                name={field}
                required
                maxLength={60}
                defaultValue={type.names[l]}
                className={inputClass}
              />
            </label>
          ))}
          {DESCRIPTION_FIELDS.map(([field, l]) => (
            <label key={field} className="flex flex-col gap-1 text-sm">
              {t(`clubTypes.${field}`)}
              <input
                name={field}
                maxLength={300}
                defaultValue={type.descriptions?.[l] ?? ""}
                className={inputClass}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-sm">
            {t("clubTypes.sortOrder")}
            <input
              name="sortOrder"
              type="number"
              min={0}
              max={1000}
              defaultValue={type.sortOrder}
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="active"
              defaultChecked={type.active}
              disabled={type.builtIn}
            />
            {t("clubTypes.active")}
            {type.builtIn ? <input type="hidden" name="active" value="on" /> : null}
          </label>
          <button type="submit" className={buttonClass}>
            {t("clubTypes.save")}
          </button>
        </ActionForm>
      </section>

      <section aria-labelledby="roles" className="space-y-4">
        <h2 id="roles" className="text-lg font-semibold">
          {t("clubTypes.roles")}
        </h2>
        <p className="text-sm text-muted">{t("clubTypes.rolesHint")}</p>
        {type.roles.map((r) => {
          const required = requiredOf(r);
          return (
            <details
              key={r.id}
              className="rounded-lg border border-border bg-raised p-4"
              data-testid="club-type-role"
            >
              <summary className="cursor-pointer">
                <span className="font-semibold">
                  {roleName(t, locale, { scope: r.scope, templateKey: r.key, names: r.names })}
                </span>{" "}
                <span className="text-sm text-muted">
                  {r.key} ·{" "}
                  {r.scope === "club" ? t("rolesAdmin.scopeClub") : t("rolesAdmin.scopeGroup")}
                  {r.required ? ` · ${t("clubTypes.required")}` : ""}
                </span>
              </summary>
              <ActionForm action="ops-update-club-type-role" className="mt-3 space-y-4">
                <input type="hidden" name="clubTypeId" value={type.id} />
                <input type="hidden" name="roleId" value={r.id} />
                <fieldset className="grid max-w-xl gap-2">
                  <legend className="text-sm font-medium">{t("clubTypes.roleNames")}</legend>
                  {NAME_FIELDS.map(([field, l]) => (
                    <label key={field} className="flex flex-col gap-1 text-sm">
                      {t(`rolesAdmin.${field}`)}
                      <input
                        name={field}
                        maxLength={60}
                        defaultValue={r.names?.[l] ?? ""}
                        className={inputClass}
                      />
                    </label>
                  ))}
                </fieldset>
                {permissionsByArea(r.scope).map((a) => (
                  <fieldset key={a.area} className="space-y-1">
                    <legend className="text-sm font-medium">{areaName(t, a.area)}</legend>
                    {a.permissions.map((p) => (
                      <label key={p} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="permission"
                          value={p}
                          defaultChecked={r.permissions.includes(p)}
                          disabled={required.includes(p as never)}
                        />
                        {permissionName(t, p)}
                        {isSensitive(p) ? (
                          <span className="rounded bg-protected-soft px-2 text-xs">
                            {t("rolesAdmin.sensitive")}
                          </span>
                        ) : null}
                        {required.includes(p as never) ? (
                          <>
                            <span className="rounded bg-accent-soft px-2 text-xs">
                              {t("rolesAdmin.locked")}
                            </span>
                            <input type="hidden" name="permission" value={p} />
                          </>
                        ) : null}
                      </label>
                    ))}
                  </fieldset>
                ))}
                <button type="submit" className={buttonClass}>
                  {t("clubTypes.saveRole")}
                </button>
              </ActionForm>
              {!r.required ? (
                <ActionForm action="ops-delete-club-type-role" className="mt-2">
                  <input type="hidden" name="clubTypeId" value={type.id} />
                  <input type="hidden" name="roleId" value={r.id} />
                  <button type="submit" className={secondaryButtonClass}>
                    {t("clubTypes.deleteRole")}
                  </button>
                </ActionForm>
              ) : null}
            </details>
          );
        })}
      </section>

      <section aria-labelledby="new-role" className="space-y-2">
        <h2 id="new-role" className="text-lg font-semibold">
          {t("clubTypes.newRole")}
        </h2>
        <p className="text-sm text-muted">{t("clubTypes.newRoleHint")}</p>
        <ActionForm action="ops-create-club-type-role" className="grid max-w-xl gap-3">
          <input type="hidden" name="clubTypeId" value={type.id} />
          <label className="flex flex-col gap-1 text-sm">
            {t("clubTypes.key")}
            <input name="key" required pattern="[a-z][a-z0-9_]{1,39}" className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("rolesAdmin.scope")}
            <select name="scope" className={inputClass} defaultValue="group">
              <option value="group">{t("rolesAdmin.scopeGroup")}</option>
              <option value="club">{t("rolesAdmin.scopeClub")}</option>
            </select>
          </label>
          {NAME_FIELDS.map(([field]) => (
            <label key={field} className="flex flex-col gap-1 text-sm">
              {t(`rolesAdmin.${field}`)}
              <input name={field} maxLength={60} className={inputClass} />
            </label>
          ))}
          <button type="submit" className={buttonClass}>
            {t("clubTypes.addRole")}
          </button>
        </ActionForm>
      </section>
    </div>
  );
}
