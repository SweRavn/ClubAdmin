// SPDX-License-Identifier: AGPL-3.0-only
// Creating a club, or asking an operator to (CLUB_CREATION, ADR 0018).
import { enumKey } from "@clubadmin/i18n";
import { JOIN_POLICIES } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../components/action-form.tsx";
import { FormError } from "../../../../components/form-error.tsx";
import { getMyProfile } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Countries with a country pack (packages/country-packs). */
const COUNTRIES = ["SE", "NO"] as const;

export async function generateMetadata() {
  return { title: (await getTranslations())("createClubForm.title") };
}

export default async function NewClubPage({ searchParams }: Props) {
  const [t, locale, profile, params] = await Promise.all([
    getTranslations(),
    getLocale(),
    getMyProfile(),
    searchParams,
  ]);
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
        <button type="submit" className={buttonClass}>
          {request ? t("createClubForm.request") : t("createClubForm.create")}
        </button>
      </ActionForm>
    </div>
  );
}
