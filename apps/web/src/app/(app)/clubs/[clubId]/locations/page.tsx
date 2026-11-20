// SPDX-License-Identifier: AGPL-3.0-only
// The club's locations (P1.4): club managers add, change, archive and
// restore any; those who manage a group's activities add places and change
// every place, its distance included (P2.5; P1.6b: only their own). Double
// bookings in the coming eight weeks for managers.
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { weekRange } from "../../../../../components/agenda.tsx";
import { ClubTime } from "../../../../../components/club-time.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getCarpoolSettings,
  getClub,
  getLocationConflicts,
  getLocations,
  getMyClubs,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
type LocationValues = {
  name?: string;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  directions?: string | null;
  distanceKm?: number | null | undefined;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("locations.title") };
}

async function LocationFields({ values = {} }: { values?: LocationValues }) {
  const t = await getTranslations();
  const field = (
    name: keyof LocationValues,
    label: string,
    props: Record<string, unknown> = {},
  ) => (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input
        name={name}
        className={inputClass}
        defaultValue={
          values[name] === null || values[name] === undefined ? "" : String(values[name])
        }
        data-testid={`location-${name}`}
        {...props}
      />
    </label>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field("name", t("locations.name"), { required: true, maxLength: 100 })}
      {field("street", t("addMember.street"), { maxLength: 200 })}
      {field("postalCode", t("addMember.postalCode"), { maxLength: 20 })}
      {field("city", t("addMember.city"), { maxLength: 100 })}
      {field("latitude", t("locations.latitude"), { inputMode: "decimal" })}
      {field("longitude", t("locations.longitude"), { inputMode: "decimal" })}
      <div className="sm:col-span-2">
        {field("directions", t("locations.directions"), { maxLength: 500 })}
      </div>
      {field("distanceKm", t("locations.distance"), { inputMode: "decimal" })}
    </div>
  );
}

export default async function LocationsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  const manages = permissions.includes("club.locations.manage");
  if (!manages && !permissions.includes("club.locations.create")) forbidden();
  const [locations, carpoolSettings] = await Promise.all([
    getLocations(club.id, true),
    getCarpoolSettings(club.id),
  ]);
  const { from, to } = weekRange(0, 8);
  const conflicts = manages
    ? await Promise.all(
        locations
          .filter((l) => !l.archived)
          .map(async (l) => ({
            location: l,
            ...(await getLocationConflicts(club.id, l.id, from, to)),
          })),
      )
    : [];
  const doubleBooked = conflicts.filter((c) => c.conflicts.length > 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("locations.title")}</h1>
      {query.added ? <Notice>{t("locations.added")}</Notice> : null}
      {query.updated ? <Notice>{t("locations.updated")}</Notice> : null}
      {query.saved ? <Notice>{t("locations.updated")}</Notice> : null}
      {query.deleted ? <Notice>{t("carpool.oldDeleted")}</Notice> : null}
      {query.removed ? <Notice>{t("locations.deleted")}</Notice> : null}
      <FormError code={query.error} />

      {doubleBooked.length > 0 ? (
        <section
          aria-labelledby="double-bookings"
          className="space-y-2"
          data-testid="double-bookings"
        >
          <h2 id="double-bookings" className="text-lg font-semibold">
            {t("locations.conflicts")}
          </h2>
          <ul className="space-y-1 text-sm">
            {doubleBooked.flatMap(({ location, conflicts: pairs }) =>
              pairs.map(({ first, second }) => (
                <li key={`${first.id}-${second.id}`}>
                  <strong>{location.name}</strong>:{" "}
                  <ClubTime
                    value={first.startsAt}
                    timeZone={first.timeZone}
                    dateStyle="medium"
                    timeStyle="short"
                  />{" "}
                  <a href={`/activities/${first.id}`} className="underline">
                    {first.title}
                  </a>{" "}
                  ({first.groups.map((g) => g.name).join(", ")}) ↔{" "}
                  <a href={`/activities/${second.id}`} className="underline">
                    {second.title}
                  </a>{" "}
                  ({second.groups.map((g) => g.name).join(", ")})
                </li>
              )),
            )}
          </ul>
        </section>
      ) : null}

      <ul className="space-y-3" data-testid="locations">
        {locations.map((l) => (
          <li
            key={l.id}
            className="rounded-lg border border-border bg-raised p-3"
            data-testid="location"
          >
            <p className="font-medium">
              {l.name}{" "}
              {l.archived ? (
                <span className="text-sm text-muted">({t("locations.archived")})</span>
              ) : null}
            </p>
            <p className="text-sm text-muted">
              {[l.street, [l.postalCode, l.city].filter(Boolean).join(" ")]
                .filter(Boolean)
                .join(", ")}
            </p>
            {l.distanceKm !== null && l.distanceKm !== undefined ? (
              <p className="text-sm" data-testid="location-distance">
                {t("locations.distanceShown", { km: l.distanceKm })}
              </p>
            ) : null}
            {l.mapUrl ? (
              <a
                href={l.mapUrl}
                className="text-sm text-accent underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                {t("activities.map")}
              </a>
            ) : null}
            {manages || l.canEdit ? (
              <>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm" data-testid="location-edit">
                    {t("locations.edit")}
                  </summary>
                  <ActionForm action="update-location" className="mt-2 space-y-3">
                    <input type="hidden" name="clubId" value={club.id} />
                    <input type="hidden" name="locationId" value={l.id} />
                    <LocationFields values={l} />
                    <button type="submit" className={buttonClass}>
                      {t("locations.save")}
                    </button>
                  </ActionForm>
                </details>
                {manages ? (
                  <ActionForm action="update-location" className="mt-2">
                    <input type="hidden" name="clubId" value={club.id} />
                    <input type="hidden" name="locationId" value={l.id} />
                    <input
                      type="hidden"
                      name="archive"
                      value={l.archived ? "restore" : "archive"}
                    />
                    <button type="submit" className={secondaryButtonClass}>
                      {l.archived ? t("locations.restore") : t("locations.archive")}
                    </button>
                  </ActionForm>
                ) : null}
                {/* P2.7c: an unused place is deleted, one in use is archived instead. */}
                {l.canDelete && (l.useCount ?? 0) === 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm" data-testid="location-delete">
                      {t("locations.delete")}
                    </summary>
                    <ActionForm action="delete-location" className="mt-2 space-y-2">
                      <input type="hidden" name="clubId" value={club.id} />
                      <input type="hidden" name="locationId" value={l.id} />
                      <p className="text-sm">{t("locations.deleteConfirm", { name: l.name })}</p>
                      <button
                        type="submit"
                        className={secondaryButtonClass}
                        data-testid="location-delete-confirm"
                      >
                        {t("locations.deleteButton")}
                      </button>
                    </ActionForm>
                  </details>
                ) : l.canDelete ? (
                  <p className="mt-2 text-xs text-muted" data-testid="location-in-use">
                    {t("locations.inUse", { count: l.useCount ?? 0 })}
                  </p>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>

      <section aria-labelledby="new-location" className="space-y-2">
        <h2 id="new-location" className="text-lg font-semibold">
          {t("locations.add")}
        </h2>
        <ActionForm action="create-location" className="space-y-3" testId="new-location-form">
          <input type="hidden" name="clubId" value={club.id} />
          <LocationFields />
          <button type="submit" className={buttonClass} data-testid="location-create">
            {t("locations.add")}
          </button>
        </ActionForm>
      </section>

      {carpoolSettings ? (
        <section aria-labelledby="carpool-settings" className="space-y-3">
          <h2 id="carpool-settings" className="text-lg font-semibold">
            {t("carpool.settings")}
          </h2>
          <ActionForm action="carpool-club-settings" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="clubId" value={club.id} />
            <input type="hidden" name="back" value={`/clubs/${club.id}/locations`} />
            <label className="block space-y-1">
              <span className="text-sm">{t("carpool.startPlace")}</span>
              <select
                name="startLocationId"
                className={inputClass}
                defaultValue={carpoolSettings.startLocationId ?? ""}
                data-testid="carpool-start-place"
              >
                <option value="">{t("activities.notGiven")}</option>
                {locations
                  .filter((l) => !l.archived)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </label>
            {/* When the way home leaves by default (P2.7f); empty: 15 minutes. */}
            <label className="block space-y-1">
              <span className="text-sm">{t("carpool.clubReturnMinutes")}</span>
              <input
                type="number"
                name="returnMinutes"
                min={0}
                max={240}
                step={5}
                defaultValue={carpoolSettings.returnMinutes ?? ""}
                placeholder="15"
                className={`${inputClass} w-32`}
                data-testid="carpool-club-return-minutes"
              />
            </label>
            <button type="submit" className={buttonClass}>
              {t("locations.save")}
            </button>
          </ActionForm>
          <p className="max-w-prose text-sm text-muted">{t("carpool.startPlaceHint")}</p>
          <p className="max-w-prose text-sm text-muted">{t("carpool.clubReturnHint")}</p>
          <ActionForm action="carpool-delete-old" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="clubId" value={club.id} />
            <input type="hidden" name="back" value={`/clubs/${club.id}/locations`} />
            <label className="block space-y-1">
              <span className="text-sm">{t("carpool.deleteBefore")}</span>
              <input type="date" name="before" required className={inputClass} />
            </label>
            <button type="submit" className={secondaryButtonClass}>
              {t("carpool.deleteOld")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
