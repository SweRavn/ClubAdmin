// SPDX-License-Identifier: AGPL-3.0-only
// My privacy (P1.8a): the consents of me and my children per club, with
// the club's text; my assignments and leaving a club; the clubs' privacy
// policies. Every change is a plain form (works without JavaScript).

import { enumKey } from "@clubadmin/i18n";
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { getMe, getMyConsents } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("privacy.title") };
}

export default async function MyPrivacyPage({ searchParams }: Props) {
  const [t, locale, timeZone, query, me, consents] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    searchParams,
    getMe(),
    getMyConsents(),
  ]);
  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">{t("privacy.title")}</h1>
      <p className="text-sm text-muted">{t("privacy.intro")}</p>
      {query.consent === "given" ? <Notice>{t("privacy.consentGiven")}</Notice> : null}
      {query.consent === "withdrawn" ? <Notice>{t("privacy.consentWithdrawn")}</Notice> : null}
      {query.left ? <Notice>{t("privacy.left")}</Notice> : null}
      {query.steppedDown ? <Notice>{t("privacy.steppedDown")}</Notice> : null}
      <FormError code={query.error} />

      <section className="space-y-4" aria-labelledby="consents">
        <h2 id="consents" className="text-xl font-semibold">
          {t("privacy.consents")}
        </h2>
        {consents.clubs.length === 0 ? (
          <p className="text-sm text-muted">{t("privacy.noClubs")}</p>
        ) : null}
        {consents.clubs.map((club) => (
          <div
            key={club.clubId}
            className="space-y-3 rounded-lg border border-border bg-raised p-4"
            data-testid={`consents-${club.clubId}`}
          >
            <div className="flex flex-wrap items-baseline gap-3">
              <h3 className="text-lg font-semibold">{club.clubName}</h3>
              <a href={`/clubs/${club.clubId}/privacy`} className="text-sm text-accent underline">
                {t("privacy.policyLink")}
              </a>
            </div>
            {club.texts.length === 0 ? (
              <p className="text-sm text-muted">{t("privacy.noneAsked")}</p>
            ) : null}
            {club.people.map(({ person, purposes }) => (
              <div key={person.id} className="space-y-2">
                <h4 className="font-medium">
                  {person.id === me.personId ? t("privacy.me") : personLabel(person)}
                </h4>
                <ul className="divide-y divide-border">
                  {purposes.map((p) => {
                    const text = club.texts.find((x) => x.purpose === p.purpose);
                    return (
                      <li
                        key={p.purpose}
                        className="space-y-1 py-2"
                        data-testid={`consent-${person.id}-${p.purpose}`}
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="font-medium">
                            {t(enumKey("consentPurposes", p.purpose))}
                          </span>
                          <span className="text-sm text-muted">
                            {!p.applicable
                              ? t("privacy.notApplicable")
                              : p.consent
                                ? t("privacy.givenOn", {
                                    when: formatDateTime(p.consent.givenAt, {
                                      locale,
                                      timeZone,
                                      dateStyle: "medium",
                                    }),
                                    by: p.consent.givenBy ? personLabel(p.consent.givenBy) : "–",
                                  })
                                : t("privacy.notGiven")}
                          </span>
                          {p.consent && !p.consent.current ? (
                            <span className="text-sm text-accent">{t("privacy.newText")}</span>
                          ) : null}
                          <span className="ml-auto flex gap-2">
                            {p.mayGive && text ? (
                              <ActionForm action="give-consent" back="/me/privacy">
                                <input type="hidden" name="personId" value={person.id} />
                                <input type="hidden" name="clubId" value={club.clubId} />
                                <input type="hidden" name="purpose" value={p.purpose} />
                                <input type="hidden" name="textVersion" value={text.textVersion} />
                                <button
                                  type="submit"
                                  className={buttonClass}
                                  data-testid={`give-${person.id}-${p.purpose}`}
                                >
                                  {t("privacy.give")}
                                </button>
                              </ActionForm>
                            ) : null}
                            {p.mayWithdraw ? (
                              <ActionForm action="withdraw-consent" back="/me/privacy">
                                <input type="hidden" name="personId" value={person.id} />
                                <input type="hidden" name="clubId" value={club.clubId} />
                                <input type="hidden" name="purpose" value={p.purpose} />
                                <button
                                  type="submit"
                                  className="rounded-md border border-border px-3 py-1.5"
                                  data-testid={`withdraw-${person.id}-${p.purpose}`}
                                >
                                  {t("privacy.withdraw")}
                                </button>
                              </ActionForm>
                            ) : null}
                          </span>
                        </div>
                        {text ? (
                          <details className="text-sm">
                            <summary className="cursor-pointer text-accent">
                              {t("privacy.readText")}
                            </summary>
                            <p className="mt-1 whitespace-pre-line">{text.body}</p>
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <a
                  href={`/me/privacy/leave?clubId=${club.clubId}&personId=${person.id}`}
                  className="text-sm text-accent underline"
                  data-testid={`leave-${club.clubId}-${person.id}`}
                >
                  {person.id === me.personId
                    ? t("privacy.leaveSelf", { club: club.clubName })
                    : t("privacy.leaveFor", { club: club.clubName, name: personLabel(person) })}
                </a>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
