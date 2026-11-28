// SPDX-License-Identifier: AGPL-3.0-only
// "Mitt konto" → Registerutdrag (P2.8): per club, what is required of me and
// why (my roles), my checks and when they need renewing, and how to get one
// (who orders it, how old it may be when shown). Nothing here is kept but
// what someone in the club ticked off.
import { enumKey } from "@clubadmin/i18n";
import { getLocale, getTranslations } from "next-intl/server";

import { getMyBackgroundChecks, getMyClubs } from "../../../../server/data.ts";

export async function generateMetadata() {
  return { title: (await getTranslations())("backgroundChecks.mineTitle") };
}

export default async function MyBackgroundChecksPage() {
  const [t, locale, mine] = await Promise.all([getTranslations(), getLocale(), getMyClubs()]);
  const results = await Promise.all(
    mine.clubs.map(async (c) => ({ club: c.club, checks: await getMyBackgroundChecks(c.club.id) })),
  );
  const shown = results.filter(
    (r) => r.checks && (r.checks.status !== "not_required" || r.checks.records.length > 0),
  );
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
      new Date(`${iso}T12:00:00Z`),
    );
  return (
    <div className="max-w-2xl space-y-6" data-testid="my-background-checks">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("backgroundChecks.mineTitle")}</h1>
        <p className="text-muted">{t("backgroundChecks.mineIntro")}</p>
      </div>
      {shown.length === 0 ? <p>{t("backgroundChecks.mineNone")}</p> : null}
      {shown.map(({ club, checks }) => (
        <section
          key={club.id}
          className="space-y-2 rounded-md border border-border p-4"
          data-testid={`my-checks-${club.id}`}
        >
          <h2 className="text-lg font-semibold">{club.name}</h2>
          <p className="font-medium" data-testid="my-check-status">
            {checks!.status === "valid" || checks!.status === "expiring"
              ? checks!.expiresOn
                ? t("backgroundChecks.mineValidUntil", { date: day(checks!.expiresOn) })
                : t("backgroundChecks.mineValid")
              : checks!.status === "missing"
                ? t("backgroundChecks.mineMissing")
                : t("backgroundChecks.mineNotRequired")}
          </p>
          {checks!.status === "expiring" ? (
            <p className="text-sm">{t("backgroundChecks.mineExpiring")}</p>
          ) : null}
          {checks!.required.map((r) => (
            <p key={r.category} className="text-sm">
              {t("backgroundChecks.mineBecause", {
                type: r.checkTypeName,
                category: t(enumKey("backgroundChecks.categories", r.category)),
                roles: r.because.join(", "),
              })}
              {r.basis ? <span className="block text-xs text-muted">{r.basis}</span> : null}
            </p>
          ))}
          {checks!.records.map((r) => (
            <p key={r.id} className="text-sm text-muted">
              {t("backgroundChecks.record", {
                type: r.checkTypeName,
                issued: day(r.issuedOn),
                verified: day(r.verifiedOn),
                method: t(enumKey("backgroundChecks.methods", r.method)),
              })}
            </p>
          ))}
          {checks!.status === "missing" || checks!.status === "expiring"
            ? checks!.howTo.map((h) => (
                <p key={h.name} className="text-sm">
                  {h.initiator === "club"
                    ? t("backgroundChecks.howClub", { name: h.name })
                    : t("backgroundChecks.howPerson", {
                        name: h.name,
                        days: h.maxAgeDaysWhenPresented ?? 0,
                      })}
                </p>
              ))
            : null}
        </section>
      ))}
    </div>
  );
}
