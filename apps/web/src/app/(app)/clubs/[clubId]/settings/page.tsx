// SPDX-License-Identifier: AGPL-3.0-only
// The club's settings (P1.6b, club managers; saving needs a second factor):
// time zone, default language, email, postal address, organisation number
// and phone numbers (rows; the order field sorts them).
import { enumKey } from "@clubadmin/i18n";
import { CLUB_PHONE_NUMBERS_MAX, UI_LOCALES } from "@clubadmin/shared";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { RowList } from "../../../../../components/row-list.tsx";
import { TimeZoneSelect } from "../../../../../components/time-zone-select.tsx";
import { formDraft, getClub, getMyClubs } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("clubSettings.title") };
}

export default async function ClubSettingsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine, draft, phoneDraft] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getMyClubs(),
    formDraft("update-club-settings", query),
    formDraft("set-club-phone-numbers", query),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.settings.update")) forbidden();
  const value = (name: string, saved: string | null | undefined) =>
    draft ? (draft.get(name)?.[0] ?? "") : (saved ?? "");
  const field = (name: string, label: string, saved: string | null | undefined, props = {}) => (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input
        name={name}
        className={inputClass}
        defaultValue={value(name, saved)}
        data-testid={`club-${name}`}
        {...props}
      />
    </label>
  );
  const phones = club.phoneNumbers ?? [];
  const phoneValue = (i: number, f: "label" | "number") =>
    phoneDraft ? (phoneDraft.get(`phone.${i}.${f}`)?.[0] ?? "") : (phones[i]?.[f] ?? "");
  let filled = phones.length;
  if (phoneDraft) {
    filled = 0;
    for (let i = 0; i < CLUB_PHONE_NUMBERS_MAX; i++) {
      if (phoneValue(i, "label") || phoneValue(i, "number")) filled = i + 1;
    }
  }
  const asked = Number(query.prows);
  const initial = Math.min(
    Math.max(filled + 1, Number.isFinite(asked) ? asked : 0),
    CLUB_PHONE_NUMBERS_MAX,
  );

  return (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-2">
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("clubSettings.title")}</h1>
        {query.updated ? <Notice>{t("clubSettings.saved")}</Notice> : null}
        <FormError code={query.error} />
        <p className="text-sm text-muted">{t("clubSettings.mfaHint")}</p>
      </div>

      <ActionForm action="update-club-settings" className="space-y-4" testId="club-settings-form">
        <input type="hidden" name="clubId" value={club.id} />
        <input type="hidden" name="country" value={club.address?.country ?? club.country} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-sm">{t("clubSettings.timeZone")}</span>
            <TimeZoneSelect
              id="club-timeZone"
              name="timeZone"
              value={value("timeZone", club.timeZone)}
              required
              testId="club-timeZone"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("clubSettings.defaultLocale")}</span>
            <select
              name="defaultLocale"
              className={inputClass}
              defaultValue={value("defaultLocale", club.defaultLocale.slice(0, 2))}
              data-testid="club-defaultLocale"
            >
              {UI_LOCALES.map((l) => (
                <option key={l} value={l} lang={l}>
                  {t(enumKey("locales", l))}
                </option>
              ))}
            </select>
          </label>
          {field("email", t("clubSettings.email"), club.email, { type: "email", maxLength: 254 })}
          {field(
            "organizationNumber",
            t("clubSettings.organizationNumber"),
            club.organizationNumber,
            {
              maxLength: 30,
            },
          )}
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-1 text-sm font-medium">{t("clubSettings.address")}</legend>
          {field("street", t("addMember.street"), club.address?.street, { maxLength: 200 })}
          {field("postalCode", t("addMember.postalCode"), club.address?.postalCode, {
            maxLength: 20,
          })}
          {field("city", t("addMember.city"), club.address?.city, { maxLength: 100 })}
        </fieldset>
        <button type="submit" className={buttonClass} data-testid="club-settings-save">
          {t("clubSettings.save")}
        </button>
      </ActionForm>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("clubSettings.phoneNumbers")}</h2>
        <ActionForm action="set-club-phone-numbers" className="space-y-3" testId="club-phones-form">
          <input type="hidden" name="clubId" value={club.id} />
          <RowList
            rows={Array.from({ length: CLUB_PHONE_NUMBERS_MAX }, (_, i) => (
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_6rem]">
                <input
                  name={`phone.${i}.label`}
                  className={inputClass}
                  placeholder={t("clubSettings.phoneLabel")}
                  aria-label={t("clubSettings.phoneLabel")}
                  defaultValue={phoneValue(i, "label")}
                  maxLength={60}
                  data-testid="phone-label"
                />
                <input
                  name={`phone.${i}.number`}
                  type="tel"
                  className={inputClass}
                  placeholder={t("clubSettings.phoneNumber")}
                  aria-label={t("clubSettings.phoneNumber")}
                  defaultValue={phoneValue(i, "number")}
                  maxLength={40}
                  data-testid="phone-number"
                />
                <input
                  name={`phone.${i}.order`}
                  type="number"
                  min={1}
                  className={inputClass}
                  aria-label={t("clubSettings.phoneOrder")}
                  defaultValue={i + 1}
                />
              </div>
            ))}
            initial={initial}
            countName="prows"
            texts={{ add: t("clubSettings.addPhone"), remove: t("events.removeRow") }}
            testId="phones"
            fallback={
              <button type="submit" name="more" value="prows" className={secondaryButtonClass}>
                {t("clubSettings.addPhone")}
              </button>
            }
          />
          <button type="submit" className={buttonClass} data-testid="club-phones-save">
            {t("clubSettings.savePhones")}
          </button>
        </ActionForm>
      </section>
    </div>
  );
}
