// SPDX-License-Identifier: AGPL-3.0-only
// Creating a club, or asking an operator to (CLUB_CREATION, ADR 0018), of a
// club type whose roles the club gets (P1.15 B).
import { enumKey } from "@clubadmin/i18n";
import { JOIN_POLICIES } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../components/action-form.tsx";
import { FormError } from "../../../../components/form-error.tsx";
import { roleName } from "../../../../components/roles.ts";
import { getClubTypes, getMyProfile } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Countries with a country pack (packages/country-packs). */
const COUNTRIES = ["SE", "NO"] as const;

export async function generateMetadata() {
  return { title: (await getTranslations())("createClubForm.title") };
}

export default async function NewClubPage({ searchParams }: Props) {
  const [t, locale, profile, params, types] = await Promise.all([
    getTranslations(),
    getLocale(),
    getMyProfile(),
    searchParams,
    getClubTypes(),
  ]);
  const lang = (texts: Record<string, string | undefined> | null) =>
    texts?.[locale.slice(0, 2)] ?? texts?.sv ?? texts?.en ?? "";
  const request = profile.clubCreation === "request";
  if (profile.clubCreation === "not_allowed") {
    return <p className="text-muted">{t("onboarding.creationNotAllowed")}</p>;
  }
  const regionNames = new Intl.DisplayNames([locale], { type: "region" });
  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold">
        {request ? t("createClubForm.requestTitle") : t("createClubForm.title")}
      </h1>
      {request ? <p className="text-muted">{t("createClubForm.requestIntro")}</p> : null}
      <FormError code={params.error} />
      <ActionForm action="create-club" className="space-y-4" testId="create-club-form">
        <label className="block space-y-1">
          <span className="font-medium">{t("createClubForm.name")}</span>
          <input name="name" required minLength={2} maxLength={200} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="font-medium">{t("createClubForm.shortName")}</span>
          <input name="shortName" maxLength={20} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="font-medium">{t("createClubForm.slug")}</span>
          <input
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            minLength={2}
            maxLength={60}
            aria-describedby="slug-hint"
            className={inputClass}
          />
          <span id="slug-hint" className="block text-sm text-muted">
            {t("createClubForm.slugHint")}
          </span>
        </label>
        <label className="block space-y-1">
          <span className="font-medium">{t("createClubForm.country")}</span>
          <select name="country" className={inputClass} defaultValue="SE">
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {regionNames.of(c) ?? c}
              </option>
            ))}
          </select>
        </label>
        {types.items.length > 1 ? (
          <fieldset className="space-y-2" data-testid="club-types">
            <legend className="font-medium">{t("createClubForm.clubType")}</legend>
            <p className="text-sm text-muted">{t("createClubForm.clubTypeHint")}</p>
            {types.items.map((type) => (
              <label
                key={type.id}
                className="flex gap-2 rounded-md border border-border p-3"
                data-testid={`club-type-${type.key}`}
              >
                <input
                  type="radio"
                  name="clubTypeId"
                  value={type.id}
                  defaultChecked={type.builtIn}
                  className="mt-1"
                />
                <span className="space-y-1">
                  <span className="block font-medium">{lang(type.names)}</span>
                  {type.descriptions ? (
                    <span className="block text-sm">{lang(type.descriptions)}</span>
                  ) : null}
                  <span className="block text-sm text-muted">
                    {t("createClubForm.clubTypeRoles", {
                      roles: type.roles
                        .map((r) =>
                          roleName(t, locale, {
                            scope: r.scope,
                            templateKey: r.key,
                            names: r.names,
                          }),
                        )
                        .join(", "),
                    })}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="block space-y-1">
          <span className="font-medium">{t("createClubForm.joinPolicy")}</span>
          <select name="joinPolicy" className={inputClass} defaultValue="approval">
            {JOIN_POLICIES.map((p) => (
              <option key={p} value={p}>
                {t(enumKey("joinPolicies", p))}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="font-medium">{t("createClubForm.secondAdministrator")}</span>
          <input
            name="secondAdministratorEmail"
            type="email"
            maxLength={254}
            autoComplete="off"
            aria-describedby="second-administrator-hint"
            className={inputClass}
          />
          <span id="second-administrator-hint" className="block text-sm text-muted">
            {t("createClubForm.secondAdministratorHint")}
          </span>
        </label>
        <button type="submit" className={buttonClass}>
          {request ? t("createClubForm.request") : t("createClubForm.create")}
        </button>
      </ActionForm>
    </div>
  );
}
