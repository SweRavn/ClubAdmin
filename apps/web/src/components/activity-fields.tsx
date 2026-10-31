// SPDX-License-Identifier: AGPL-3.0-only
// The fields of the activity forms (new and edit): kind, title, local date
// and times in the club's time zone, place (a club location or free text),
// meeting time and place, match details and notes.
import { enumKey } from "@clubadmin/i18n";
import { ACTIVITY_KINDS, HOME_AWAY, type Location } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { inputClass } from "./action-form.tsx";
import { ResponseModeFields } from "./response-mode-fields.tsx";

export interface ActivityFieldValues {
  kind?: string;
  kindLabel?: string | null;
  title?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  meetTime?: string;
  meetPlace?: string | null;
  locationId?: string | null;
  locationText?: string | null;
  opponent?: string | null;
  homeAway?: string | null;
  competition?: string | null;
  notes?: string | null;
  leaderNotes?: string | null;
  responseMode?: string | null;
  respondByHours?: number | null;
}

export async function ActivityFields({
  timeZone,
  locations,
  values = {},
  addPlaceHref,
}: {
  timeZone: string;
  locations: readonly Location[];
  values?: ActivityFieldValues;
  /** The places page, for those who may add a place (P1.6b). */
  addPlaceHref?: string | null;
}) {
  const t = await getTranslations();
  const input = (
    name: keyof ActivityFieldValues,
    label: string,
    props: Record<string, unknown> = {},
  ) => (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input
        name={name}
        className={inputClass}
        defaultValue={values[name] ?? ""}
        data-testid={`activity-${name}`}
        {...props}
      />
    </label>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="timeZone" value={timeZone} />
      <div className="group space-y-2">
        <label className="block space-y-1">
          <span className="text-sm">{t("activities.kind")}</span>
          <select
            name="kind"
            className={inputClass}
            defaultValue={values.kind ?? "match"}
            data-testid="activity-kind"
          >
            {ACTIVITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(enumKey("activityKinds", k))}
              </option>
            ))}
          </select>
        </label>
        {/* "Other": what it is (P1.6b); shown when "Other" is chosen. */}
        <label className="hidden space-y-1 group-has-[option[value=other]:checked]:block">
          <span className="text-sm">{t("activities.kindLabel")}</span>
          <input
            name="kindLabel"
            className={inputClass}
            defaultValue={values.kindLabel ?? ""}
            maxLength={60}
            data-testid="activity-kindLabel"
          />
        </label>
      </div>
      {input("title", t("activities.titleField"), { required: true, maxLength: 120 })}
      {input("date", t("activities.date"), { type: "date", required: true })}
      <div className="grid grid-cols-2 gap-3">
        {input("startTime", t("activities.startTime"), { type: "time", required: true })}
        {input("endTime", t("activities.endTime"), { type: "time", required: true })}
      </div>
      <p className="text-xs text-muted sm:col-span-2">
        {t("activities.timeZoneHint", { zone: timeZone })}
      </p>
      <label className="block space-y-1">
        <span className="text-sm">{t("activities.location")}</span>
        <select
          name="locationId"
          className={inputClass}
          defaultValue={values.locationId ?? ""}
          data-testid="activity-locationId"
        >
          <option value="">{t("activities.otherPlace")}</option>
          {locations
            .filter((l) => !l.archived || l.id === values.locationId)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
      </label>
      {input("locationText", t("activities.locationText"), { maxLength: 200 })}
      {addPlaceHref ? (
        <p className="text-sm sm:col-span-2">
          <a href={addPlaceHref} className="underline" data-testid="add-place-link">
            {t("locations.addLink")}
          </a>
        </p>
      ) : null}
      {input("meetTime", t("activities.meetTime"), { type: "time" })}
      {input("meetPlace", t("activities.meetPlace"), { maxLength: 200 })}
      {input("opponent", t("activities.opponent"), { maxLength: 120 })}
      <label className="block space-y-1">
        <span className="text-sm">{t("activities.homeAway")}</span>
        <select name="homeAway" className={inputClass} defaultValue={values.homeAway ?? ""}>
          <option value="">{t("activities.notGiven")}</option>
          {HOME_AWAY.map((h) => (
            <option key={h} value={h}>
              {t(enumKey("homeAway", h))}
            </option>
          ))}
        </select>
      </label>
      {input("competition", t("activities.competition"), { maxLength: 120 })}
      <ResponseModeFields mode={values.responseMode} hours={values.respondByHours} />
      <label className="block space-y-1 sm:col-span-2">
        <span className="text-sm">{t("activities.notes")}</span>
        <textarea
          name="notes"
          rows={3}
          maxLength={2000}
          className={inputClass}
          defaultValue={values.notes ?? ""}
          data-testid="activity-notes"
        />
      </label>
      <label className="block space-y-1 sm:col-span-2">
        <span className="text-sm">{t("activities.leaderNotes")}</span>
        <textarea
          name="leaderNotes"
          rows={2}
          maxLength={2000}
          className={inputClass}
          defaultValue={values.leaderNotes ?? ""}
          data-testid="activity-leaderNotes"
        />
        <span className="text-xs text-muted">{t("activities.leaderNotesHint")}</span>
      </label>
    </div>
  );
}
