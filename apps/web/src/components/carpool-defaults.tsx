// SPDX-License-Identifier: AGPL-3.0-only
// My car-pool defaults (P2.7f), on "Min profil" for adults: what "Skapa
// samåkning" offers (seats, departure place, a note to the passengers) and
// how long after an activity's end I leave for home (empty: the activity's
// or the club's, else 15 minutes). Saved in place (ADR 0055).
import type { PersonalCarpoolSettings } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";

export async function CarpoolDefaults({ settings }: { settings: PersonalCarpoolSettings | null }) {
  const t = await getTranslations();
  return (
    <section className="space-y-3" data-testid="carpool-defaults">
      <h2 className="text-lg font-semibold">{t("carpool.defaults.title")}</h2>
      <p className="text-sm text-muted">{t("carpool.defaults.intro")}</p>
      <ActionForm action="carpool-defaults" className="space-y-3" testId="carpool-defaults-form">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-sm">{t("carpool.defaults.seats")}</span>
            <input
              type="number"
              name="seats"
              min={1}
              max={8}
              required
              defaultValue={settings?.seats ?? 3}
              className={inputClass}
              data-testid="carpool-defaults-seats"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("carpool.defaults.returnMinutes")}</span>
            <input
              type="number"
              name="returnMinutes"
              min={0}
              max={240}
              step={5}
              defaultValue={settings?.returnMinutes ?? ""}
              className={inputClass}
              data-testid="carpool-defaults-returnMinutes"
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-sm">{t("carpool.defaults.departurePlace")}</span>
          <input
            name="departurePlace"
            maxLength={200}
            defaultValue={settings?.departurePlace ?? ""}
            className={inputClass}
            data-testid="carpool-defaults-place"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">{t("carpool.defaults.note")}</span>
          <textarea
            name="note"
            maxLength={300}
            rows={2}
            defaultValue={settings?.note ?? ""}
            className={inputClass}
            data-testid="carpool-defaults-note"
          />
        </label>
        <p className="text-xs text-muted">{t("carpool.defaults.returnHint")}</p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass} data-testid="carpool-defaults-save">
            {t("carpool.defaults.save")}
          </button>
          {settings ? (
            <button
              type="submit"
              name="clear"
              value="1"
              className={secondaryButtonClass}
              data-testid="carpool-defaults-clear"
            >
              {t("carpool.defaults.clear")}
            </button>
          ) : null}
        </div>
      </ActionForm>
    </section>
  );
}
