// SPDX-License-Identifier: AGPL-3.0-only
// The club's privacy page (P1.8a), for everyone in the club: the privacy
// policy (built from the template and the club's settings), every rule with
// its value and the board decision it rests on, the consents the club asks
// for with their texts. Club managers (with a second factor) record the
// board's decisions, publish consent texts and set the privacy contact.

import { enumKey } from "@clubadmin/i18n";
import { type BoardSettingKey, CONSENT_PURPOSES } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getClub,
  getClubPrivacy,
  getMyClubs,
  getPrivacyPolicy,
  getSettingDecisions,
} from "../../../../../server/data.ts";

type Params = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("privacy.clubTitle") };
}

export default async function ClubPrivacyPage({ params, searchParams }: Params) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const version = typeof query.version === "string" ? Number(query.version) || null : null;
  const [t, club, privacy, policy, decisions, mine] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubPrivacy(clubId),
    getPrivacyPolicy(clubId, version),
    getSettingDecisions(clubId),
    getMyClubs(),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === clubId)?.permissions ?? [];
  const canDecide = permissions.includes("club.settings.update");
  const decisionLabel = (d: { body: string; decidedOn: string; reference: string } | null) =>
    d
      ? t("privacy.decidedBy", {
          body: t(`privacy.bodies.${d.body as "board" | "annual_meeting" | "extra_meeting"}`),
          date: d.decidedOn,
          reference: d.reference,
        })
      : t("privacy.notDecided");

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">{t("privacy.clubHeading", { club: club.name })}</h1>
      {query.decided ? <Notice>{t("privacy.decisionRecorded")}</Notice> : null}
      {query.published ? <Notice>{t("privacy.textPublished")}</Notice> : null}
      {query.updated ? <Notice>{t("clubSettings.saved")}</Notice> : null}
      <FormError code={query.error} />

      <section aria-labelledby="policy" className="space-y-3" data-testid="privacy-policy">
        <h2 id="policy" className="text-xl font-semibold">
          {t("privacy.policy", { version: policy.version, date: policy.effectiveFrom })}
        </h2>
        {policy.sections.map((s) => (
          <div key={s.key}>
            <h3 className="font-semibold">{s.title}</h3>
            <p className="whitespace-pre-line text-sm">{s.body}</p>
          </div>
        ))}
        {policy.versions.length > 1 ? (
          <p className="text-sm">
            {t("privacy.versions")}{" "}
            {policy.versions.map((v) => (
              <a
                key={v.version}
                href={`/clubs/${clubId}/privacy?version=${v.version}`}
                className="mr-2 text-accent underline"
              >
                {t("privacy.versionShort", { version: v.version, date: v.effectiveFrom })}
              </a>
            ))}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="rules" className="space-y-2">
        <h2 id="rules" className="text-xl font-semibold">
          {t("privacy.rules")}
        </h2>
        <table className="w-full text-sm" data-testid="privacy-rules">
          <tbody className="divide-y divide-border">
            {privacy.settings
              .filter((s) => s.decidedBy === "board")
              .map((s) => (
                <tr key={s.key} data-setting={s.key}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {t(`privacy.settings.${s.key as BoardSettingKey}`)}
                  </th>
                  <td className="py-2 pr-3">
                    {Array.isArray(s.value)
                      ? (s.value as string[])
                          .map((p) => t(enumKey("consentPurposes", p)))
                          .join(", ") || "–"
                      : typeof s.value === "boolean"
                        ? s.value
                          ? t("common.yes")
                          : t("common.no")
                        : `${String(s.value)} ${s.unit === "days" ? t("privacy.days") : t("privacy.months")}`}
                  </td>
                  <td className="py-2 text-muted">{decisionLabel(s.decision)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {privacy.pending.length > 0 ? (
          <p className="text-sm" data-testid="privacy-pending">
            {t("privacy.pending", { count: privacy.pending.length })}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="texts" className="space-y-2">
        <h2 id="texts" className="text-xl font-semibold">
          {t("privacy.texts")}
        </h2>
        {privacy.texts.map((text) => (
          <details key={text.purpose} className="text-sm">
            <summary className="cursor-pointer font-medium">
              {t(enumKey("consentPurposes", text.purpose))}
            </summary>
            <p className="mt-1 whitespace-pre-line">{text.body}</p>
          </details>
        ))}
      </section>

      {decisions.items.length > 0 ? (
        <section aria-labelledby="decisions" className="space-y-2">
          <h2 id="decisions" className="text-xl font-semibold">
            {t("privacy.decisions")}
          </h2>
          <ul className="space-y-1 text-sm" data-testid="privacy-decisions">
            {decisions.items.map((d) => (
              <li key={d.id}>
                {decisionLabel(d)}
                {d.applied ? "" : ` · ${t("privacy.effectiveFrom", { date: d.effectiveFrom })}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canDecide ? (
        <section
          aria-labelledby="record"
          className="space-y-3 rounded-lg border border-border bg-raised p-4"
        >
          <h2 id="record" className="text-lg font-semibold">
            {t("privacy.recordDecision")}
          </h2>
          <p className="text-sm text-muted">{t("privacy.recordHint")}</p>
          <ActionForm action="record-decision" className="space-y-3" testId="record-decision">
            <input type="hidden" name="clubId" value={clubId} />
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block space-y-1 text-sm">
                <span>{t("privacy.body")}</span>
                <select name="body" className={inputClass} defaultValue="board">
                  {(["board", "annual_meeting", "extra_meeting"] as const).map((b) => (
                    <option key={b} value={b}>
                      {t(`privacy.bodies.${b}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm">
                <span>{t("privacy.decidedOn")}</span>
                <input type="date" name="decidedOn" required className={inputClass} />
              </label>
              <label className="block space-y-1 text-sm">
                <span>{t("privacy.reference")}</span>
                <input name="reference" required maxLength={200} className={inputClass} />
              </label>
            </div>
            <label className="block space-y-1 text-sm">
              <span>{t("privacy.effectiveFromLabel")}</span>
              <input type="date" name="effectiveFrom" className={inputClass} />
            </label>
            {privacy.settings
              .filter((s) => s.decidedBy === "board")
              .map((s) => (
                <fieldset key={s.key} className="space-y-1 rounded-md border border-border p-2">
                  <legend className="px-1 text-sm">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name={`change.${s.key}`} />
                      {t(`privacy.settings.${s.key as BoardSettingKey}`)}
                    </label>
                  </legend>
                  {Array.isArray(s.value) ? (
                    <div className="flex flex-wrap gap-3 text-sm">
                      {CONSENT_PURPOSES.map((p) => (
                        <label key={p} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            name={`value.${s.key}`}
                            value={p}
                            defaultChecked={(s.value as string[]).includes(p)}
                          />
                          {t(enumKey("consentPurposes", p))}
                        </label>
                      ))}
                    </div>
                  ) : typeof s.value === "boolean" ? (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name={`value.${s.key}`} defaultChecked={s.value} />
                      {t("common.yes")}
                    </label>
                  ) : (
                    <input
                      type="number"
                      name={`value.${s.key}`}
                      min={s.min}
                      max={s.max}
                      defaultValue={Number(s.value)}
                      className={inputClass}
                    />
                  )}
                </fieldset>
              ))}
            <button type="submit" className={buttonClass}>
              {t("privacy.recordButton")}
            </button>
          </ActionForm>
        </section>
      ) : null}

      {canDecide ? (
        <section className="space-y-3 rounded-lg border border-border bg-raised p-4">
          <h2 className="text-lg font-semibold">{t("privacy.publishText")}</h2>
          <ActionForm action="publish-consent-text" className="space-y-2" testId="publish-text">
            <input type="hidden" name="clubId" value={clubId} />
            <select name="purpose" className={inputClass}>
              {privacy.consentPurposes.map((p) => (
                <option key={p} value={p}>
                  {t(enumKey("consentPurposes", p))}
                </option>
              ))}
            </select>
            {(["sv", "en", "nb"] as const).map((l) => (
              <label key={l} className="block space-y-1 text-sm">
                <span>{t(enumKey("locales", l))}</span>
                <textarea name={`text.${l}`} rows={3} maxLength={4000} className={inputClass} />
              </label>
            ))}
            <button type="submit" className={buttonClass}>
              {t("privacy.publishButton")}
            </button>
          </ActionForm>
          <ActionForm action="set-privacy-contact" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="clubId" value={clubId} />
            <label className="block space-y-1 text-sm">
              <span>{t("privacy.contact")}</span>
              <input
                type="email"
                name="privacyContactEmail"
                defaultValue={privacy.privacyContactEmail ?? ""}
                className={inputClass}
              />
            </label>
            <button type="submit" className="rounded-md border border-border px-3 py-2">
              {t("common.save")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
