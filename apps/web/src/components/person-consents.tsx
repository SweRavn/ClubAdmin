// SPDX-License-Identifier: AGPL-3.0-only
// A person's consents in a club on the person page (P1.8a): status per
// purpose for whoever may read it (the family, administrators, the leaders
// of the person's groups); registrars and club managers record a paper
// consent with a note or withdraw on request.

import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { getClubPrivacy, getPersonConsents } from "../server/data.ts";
import { ActionForm, buttonClass, inputClass } from "./action-form.tsx";

export async function PersonConsents({ personId, clubId }: { personId: string; clubId: string }) {
  const consents = await getPersonConsents(personId, clubId);
  if (!consents) return null;
  const t = await getTranslations();
  const texts = consents.mayRecord ? (await getClubPrivacy(clubId)).texts : [];
  return (
    <section
      aria-labelledby="person-consents"
      className="space-y-2 rounded-lg border border-border bg-raised p-4"
      data-testid="person-consents"
    >
      <h2 id="person-consents" className="text-lg font-semibold">
        {t("privacy.consents")}
      </h2>
      <ul className="divide-y divide-border text-sm">
        {consents.purposes.map((p) => (
          <li key={p.purpose} className="flex flex-wrap items-center gap-3 py-1.5">
            <span className="font-medium">{t(enumKey("consentPurposes", p.purpose))}</span>
            <span className="text-muted">
              {!p.applicable
                ? t("privacy.notApplicable")
                : p.consent
                  ? t("privacy.statusGiven")
                  : t("privacy.statusMissing")}
              {p.consent?.givenBy ? ` (${personLabel(p.consent.givenBy)})` : ""}
            </span>
            {consents.mayRecord && p.mayWithdraw ? (
              <ActionForm action="withdraw-consent" className="ml-auto">
                <input type="hidden" name="personId" value={personId} />
                <input type="hidden" name="clubId" value={clubId} />
                <input type="hidden" name="purpose" value={p.purpose} />
                <button type="submit" className="rounded-md border border-border px-2 py-1">
                  {t("privacy.withdrawOnRequest")}
                </button>
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ul>
      {consents.mayRecord && texts.length > 0 ? (
        <ActionForm
          action="give-consent"
          className="flex flex-wrap items-end gap-2"
          testId="record-consent"
        >
          <input type="hidden" name="personId" value={personId} />
          <input type="hidden" name="clubId" value={clubId} />
          <label className="block space-y-1 text-sm">
            <span>{t("privacy.purpose")}</span>
            <select name="purpose" className={inputClass}>
              {consents.purposes
                .filter((p) => p.mayGive)
                .map((p) => (
                  <option key={p.purpose} value={p.purpose}>
                    {t(enumKey("consentPurposes", p.purpose))}
                  </option>
                ))}
            </select>
          </label>
          {/* The record is for the club's current text of the chosen purpose. */}
          {texts.map((x) => (
            <input
              key={x.purpose}
              type="hidden"
              name={`version.${x.purpose}`}
              value={x.textVersion}
            />
          ))}
          <label className="block flex-1 space-y-1 text-sm">
            <span>{t("privacy.clubNote")}</span>
            <input name="clubNote" required maxLength={500} className={inputClass} />
          </label>
          <button type="submit" className={buttonClass}>
            {t("privacy.recordPaper")}
          </button>
        </ActionForm>
      ) : null}
    </section>
  );
}
