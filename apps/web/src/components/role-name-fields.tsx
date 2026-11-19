// SPDX-License-Identifier: AGPL-3.0-only
// A role's names (P2.7b): the club's language and English first (required for
// a club's own role), the other languages under "More languages", optional and
// shown in the club's language or English until they are set.
import { getTranslations } from "next-intl/server";

import { inputClass } from "./action-form.tsx";

const FIELDS = { sv: "nameSv", en: "nameEn", nb: "nameNb" } as const;
type Lang = keyof typeof FIELDS;

/** The club's language from its default locale ("sv-SE" → "sv", "nb-NO" → "nb"). */
export function clubLanguage(defaultLocale: string): Lang {
  const lang = defaultLocale.slice(0, 2).toLowerCase();
  return lang === "nb" || lang === "no" ? "nb" : lang === "sv" ? "sv" : "en";
}

export async function RoleNameFields({
  clubLocale,
  values = {},
  required,
}: {
  clubLocale: string;
  values?: Partial<Record<(typeof FIELDS)[Lang], string>>;
  /** A club's own role: the club's language and English are required. */
  required: boolean;
}) {
  const t = await getTranslations();
  const own = clubLanguage(clubLocale);
  const first: Lang[] = [...new Set<Lang>([own, "en"])];
  const more = (Object.keys(FIELDS) as Lang[]).filter((l) => !first.includes(l));
  const field = (lang: Lang, isRequired: boolean) => (
    <label key={lang} className="flex flex-col gap-1 text-sm">
      {t(`rolesAdmin.${FIELDS[lang]}`)}
      <input
        name={FIELDS[lang]}
        defaultValue={values[FIELDS[lang]] ?? ""}
        maxLength={60}
        className={inputClass}
        required={isRequired}
        data-testid={`role-${FIELDS[lang]}`}
      />
    </label>
  );
  return (
    <>
      {first.map((lang) => field(lang, required))}
      {more.length > 0 ? (
        <details open={more.some((l) => Boolean(values[FIELDS[l]]))} className="text-sm">
          <summary className="cursor-pointer" data-testid="role-more-languages">
            {t("rolesAdmin.moreLanguages")}
          </summary>
          <p className="mt-1 text-muted">{t("rolesAdmin.moreLanguagesHint")}</p>
          <div className="mt-2 grid gap-3">{more.map((lang) => field(lang, false))}</div>
        </details>
      ) : null}
    </>
  );
}
