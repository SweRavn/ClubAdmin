// SPDX-License-Identifier: AGPL-3.0-only
// The club's locations (P1.4, club managers): add, change, archive and
// restore; double bookings in the coming eight weeks for each.
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
    </div>
  );
}

export default async function LocationsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.locations.manage")) forbidden();
  const locations = await getLocations(club.id, true);
  const { from, to } = weekRange(0, 8);
  const conflicts = await Promise.all(
    locations
      .filter((l) => !l.archived)
      .map(async (l) => ({
        location: l,
        ...(await getLocationConflicts(club.id, l.id, from, to)),
      })),
  );
  const doubleBooked = conflicts.filter((c) => c.conflicts.length > 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("locations.title")}</h1>
      {query.added ? <Notice>{t("locations.added")}</Notice> : null}
      {query.updated ? <Notice>{t("locations.updated")}</Notice> : null}
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
            <details className="mt-2">
              <summary className="cursor-pointer text-sm">{t("locations.edit")}</summary>
              <ActionForm action="update-location" className="mt-2 space-y-3">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="locationId" value={l.id} />
                <LocationFields values={l} />
                <button type="submit" className={buttonClass}>
                  {t("locations.save")}
                </button>
              </ActionForm>
            </details>
            <ActionForm action="update-location" className="mt-2">
              <input type="hidden" name="clubId" value={club.id} />
              <input type="hidden" name="locationId" value={l.id} />
              <input type="hidden" name="archive" value={l.archived ? "restore" : "archive"} />
              <button type="submit" className={secondaryButtonClass}>
                {l.archived ? t("locations.restore") : t("locations.archive")}
              </button>
            </ActionForm>
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
    </div>
  );
}
