// SPDX-License-Identifier: AGPL-3.0-only
// Club types (P1.15 B, operators): the types with their roles, and a new
// type (it starts with the roles every type needs).
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { roleName } from "../../../../components/roles.ts";
import { getOpsClubTypes } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("clubTypes.title") };
}

export default async function ClubTypesPage({ searchParams }: Props) {
  const [t, locale, query, types] = await Promise.all([
    getTranslations(),
    getLocale(),
    searchParams,
    getOpsClubTypes(),
  ]);
  const lang = (texts: Record<string, string | undefined> | null) =>
    texts?.[locale.slice(0, 2)] ?? texts?.sv ?? "";
  return (
    <div className="space-y-6" data-testid="club-types-page">
      <h1 className="text-2xl font-semibold">{t("clubTypes.title")}</h1>
      <p>{t("clubTypes.intro")}</p>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("clubTypes.saved")}</Notice> : null}
      <ul className="space-y-3">
        {(types?.items ?? []).map((type) => (
          <li
            key={type.id}
            className="space-y-1 rounded-lg border border-border bg-raised p-4"
            data-testid="club-type"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <a href={`/ops/club-types/${type.id}`} className="font-semibold underline">
                {lang(type.names)}
              </a>
              <span className="text-sm text-muted">{type.key}</span>
              {type.builtIn ? (
                <span className="rounded bg-accent-soft px-2 text-xs">
                  {t("clubTypes.builtIn")}
                </span>
              ) : null}
              {!type.active ? (
                <span className="rounded bg-protected-soft px-2 text-xs">
                  {t("clubTypes.inactive")}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted">
              {type.roles
                .map((r) =>
                  roleName(t, locale, { scope: r.scope, templateKey: r.key, names: r.names }),
                )
                .join(", ")}
            </p>
          </li>
        ))}
      </ul>
      <section aria-labelledby="new-type" className="space-y-2">
        <h2 id="new-type" className="text-lg font-semibold">
          {t("clubTypes.newType")}
        </h2>
        <p className="text-sm text-muted">{t("clubTypes.newTypeHint")}</p>
        <ActionForm action="ops-create-club-type" className="grid max-w-xl gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t("clubTypes.key")}
            <input
              name="key"
              required
              pattern="[a-z][a-z0-9_]{1,39}"
              className={inputClass}
              aria-describedby="key-hint"
            />
            <span id="key-hint" className="text-muted">
              {t("clubTypes.keyHint")}
            </span>
          </label>
          {(["nameSv", "nameEn", "nameNb"] as const).map((field) => (
            <label key={field} className="flex flex-col gap-1 text-sm">
              {t(`rolesAdmin.${field}`)}
              <input name={field} required maxLength={60} className={inputClass} />
            </label>
          ))}
          {(["descriptionSv", "descriptionEn", "descriptionNb"] as const).map((field) => (
            <label key={field} className="flex flex-col gap-1 text-sm">
              {t(`clubTypes.${field}`)}
              <input name={field} maxLength={300} className={inputClass} />
            </label>
          ))}
          <button type="submit" className={buttonClass}>
            {t("clubTypes.create")}
          </button>
        </ActionForm>
      </section>
    </div>
  );
}
