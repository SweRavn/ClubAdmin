// SPDX-License-Identifier: AGPL-3.0-only
// "Min profil": completing the profile after sign-up (P1.1: name and birth
// date), and since P2.7d (ADR 0057) one's own phone, address and login
// email. A new email waits for the code sent to it; until then the old one
// logs in and the page says the change is waiting. Children's contact
// details are changed on their profiles (a guardian acting for them).
import { PersonName } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../components/action-form.tsx";
import { CarpoolDefaults } from "../../../../components/carpool-defaults.tsx";
import { ContactForm } from "../../../../components/contact-form.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { resolveTimeZone } from "../../../../server/context.ts";
import { getMyCarpoolSettings, getMyProfile, getMyWards } from "../../../../server/data.ts";
import { safeReturnTo } from "../../../../server/return-to.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("profileForm.title") };
}

export default async function ProfilePage({ searchParams }: Props) {
  const [t, locale, profile, params] = await Promise.all([
    getTranslations(),
    getLocale(),
    getMyProfile(),
    searchParams,
  ]);
  const next = safeReturnTo(typeof params.next === "string" ? params.next : null);
  const saved = typeof params.saved === "string" ? params.saved : null;
  const carpool = profile.complete ? await getMyCarpoolSettings() : null;
  // The person's own zone (their setting, the club's, the browser's), never the server's.
  const zone = await resolveTimeZone();
  const wards = profile.complete
    ? (await getMyWards()).wards.filter((w) => w.rights.includes("act_on_behalf"))
    : [];
  return (
    <div className="max-w-lg space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("profileForm.title")}</h1>
        <FormError code={params.error} />
        {saved === "contact" ? <Notice>{t("contact.saved")}</Notice> : null}
        {saved === "email" ? <Notice>{t("contact.emailSaved")}</Notice> : null}
        {saved === "carpool" ? <Notice>{t("carpool.defaults.saved")}</Notice> : null}
      </div>

      <section className="space-y-3">
        <p className="text-lg">
          <PersonName person={profile.person} protectedLabel={t("protected.tooltip")} />
        </p>
        {profile.complete ? null : <p className="text-muted">{t("profileForm.intro")}</p>}
        <ActionForm
          action="complete-profile"
          {...(profile.complete ? {} : { back: next })}
          className="space-y-4"
          testId="profile-form"
        >
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
          {profile.complete ? null : (
            <button type="submit" className={buttonClass}>
              {t("profileForm.save")}
            </button>
          )}
        </ActionForm>
      </section>

      {profile.complete ? (
        <section className="space-y-3" data-testid="own-contact">
          <h2 className="text-lg font-semibold">{t("contact.title")}</h2>
          <p className="text-sm text-muted">{t("contact.intro")}</p>
          <ContactForm
            personId={profile.person.id}
            phone={profile.phone}
            address={profile.address}
            scope="self"
            protectedIdentity={profile.protectedIdentity ?? false}
          />
        </section>
      ) : null}

      {profile.email ? (
        <section className="space-y-3" data-testid="own-email">
          <h2 className="text-lg font-semibold">{t("contact.emailTitle")}</h2>
          <p>
            {t("contact.currentEmail")}{" "}
            <span className="font-medium" data-testid="current-email">
              {profile.email}
            </span>
          </p>
          {profile.pendingEmail ? (
            <div
              className="space-y-3 rounded-md border border-border p-3"
              data-testid="pending-email"
            >
              <p>
                {t("contact.pending", {
                  email: profile.pendingEmail.email,
                  until: new Intl.DateTimeFormat(locale, {
                    timeStyle: "short",
                    timeZone: zone,
                  }).format(new Date(profile.pendingEmail.expiresAt)),
                })}
              </p>
              <ActionForm action="confirm-email-change" className="flex flex-wrap items-end gap-2">
                <label className="space-y-1">
                  <span className="block text-sm font-medium">{t("contact.code")}</span>
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]{6,7}"
                    required
                    className={`${inputClass} w-40`}
                    data-testid="email-code"
                  />
                </label>
                <button type="submit" className={buttonClass} data-testid="email-confirm">
                  {t("contact.confirm")}
                </button>
              </ActionForm>
              <ActionForm action="cancel-email-change">
                <button type="submit" className="text-sm underline" data-testid="email-cancel">
                  {t("contact.cancelChange")}
                </button>
              </ActionForm>
            </div>
          ) : (
            <ActionForm action="request-email-change" className="space-y-2" testId="email-form">
              <label className="block space-y-1">
                <span className="font-medium">{t("contact.newEmail")}</span>
                <input
                  type="email"
                  name="email"
                  required
                  autoComplete="email"
                  className={inputClass}
                  data-testid="new-email"
                />
              </label>
              <p className="text-sm text-muted">{t("contact.emailHelp")}</p>
              <button type="submit" className={secondaryButtonClass} data-testid="email-request">
                {t("contact.sendCode")}
              </button>
            </ActionForm>
          )}
        </section>
      ) : null}

      {/* Car-pool defaults (P2.7f): adults only. */}
      {carpool?.canSet ? <CarpoolDefaults settings={carpool.settings} /> : null}

      {wards.length > 0 ? (
        <section className="space-y-2" data-testid="ward-contacts">
          <h2 className="text-lg font-semibold">{t("contact.wardsTitle")}</h2>
          <p className="text-sm text-muted">{t("contact.wardsIntro")}</p>
          <ul className="space-y-1">
            {wards.map((w) => (
              <li key={w.person.id}>
                <a href={`/people/${w.person.id}`} className="underline">
                  <PersonName person={w.person} protectedLabel={t("protected.tooltip")} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
