// SPDX-License-Identifier: AGPL-3.0-only
// "Skapa samåkning" (P2.7f): one tap offers my car there and home with my
// own defaults (seats, departure place, a note); the way home leaves at the
// activity's, my, the club's or 15 minutes after the end (the API decides).
// Shown under an activity in the group's list to those who keep defaults.
import type { PersonalCarpoolSettings } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { ActionForm } from "./action-form.tsx";

export async function CarpoolQuick({
  activityId,
  settings,
  returnPlace,
}: {
  activityId: string;
  settings: PersonalCarpoolSettings;
  /** Where the way home leaves: the activity's place. */
  returnPlace: string | null;
}) {
  const t = await getTranslations();
  return (
    <ActionForm action="carpool-quick" className="inline">
      <input type="hidden" name="activityId" value={activityId} />
      <input type="hidden" name="seats" value={settings.seats} />
      <input type="hidden" name="departurePlace" value={settings.departurePlace ?? ""} />
      <input type="hidden" name="note" value={settings.note ?? ""} />
      <input type="hidden" name="withReturn" value="on" />
      <input type="hidden" name="returnDeparturePlace" value={returnPlace ?? ""} />
      <button
        type="submit"
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface"
        data-testid="carpool-quick"
      >
        {t("carpool.quick", { seats: settings.seats })}
      </button>
    </ActionForm>
  );
}
