// SPDX-License-Identifier: AGPL-3.0-only
// Completing the profile after sign-up (P1.1): name and birth date.
import { PersonName } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../components/action-form.tsx";
import { FormError } from "../../../../components/form-error.tsx";
import { getMyProfile } from "../../../../server/data.ts";
import { safeReturnTo } from "../../../../server/return-to.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("profileForm.title") };
}

export default async function ProfilePage({ searchParams }: Props) {
  const [t, profile, params] = await Promise.all([getTranslations(), getMyProfile(), searchParams]);
  const next = safeReturnTo(typeof params.next === "string" ? params.next : null);
  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold">{t("profileForm.title")}</h1>
      <p className="text-muted">{t("profileForm.intro")}</p>
      <FormError code={params.error} />
      <ActionForm action="complete-profile" back={next} className="space-y-4" testId="profile-form">
        <p>
          <PersonName person={profile.person} protectedLabel={t("protected.tooltip")} />
        </p>
        <label className="block space-y-1">
          <span className="font-medium">{t("profileForm.birthDate")}</span>
          <input
            type="date"
            name="birthDate"
            required
            autoComplete="bday"
            defaultValue={profile.birthDate ?? ""}
            readOnly={profile.birthDate !== null}
            className={inputClass}
          />
        </label>
        <button type="submit" className={buttonClass}>
          {t("profileForm.save")}
        </button>
      </ActionForm>
    </div>
  );
}
