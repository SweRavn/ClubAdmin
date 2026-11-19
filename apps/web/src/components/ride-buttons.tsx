// SPDX-License-Identifier: AGPL-3.0-only
// A seat in a car from the schedule and the group's list (P2.7c, ADR 0048):
// per person and direction, "Åk med dit" / "Åk med hem" books one tap (one
// car), or opens the list of cars with free seats (driver, place, time);
// a booked seat says whose car it is and can be cancelled. The data is the
// club's car pool summaries (one request per club and page).
import type { CarpoolSummary } from "@clubadmin/shared";
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm } from "./action-form.tsx";

type Offer = CarpoolSummary["offers"][number];

const small = "rounded-md border border-border px-2 py-1 text-xs hover:bg-surface";

/** The cars a person may take in one direction: free seats, not their own. */
export function carsFor(
  carpool: CarpoolSummary | undefined,
  personId: string,
  direction: "out" | "back",
): Offer[] {
  if (!carpool?.open || !carpool.canBookFor.some((p) => p.id === personId)) return [];
  return carpool.offers.filter((o) => o.direction === direction && !o.mine && o.freeSeats > 0);
}

/** "Anna Lindqvist · Klubbstugan 08:30": the driver, the pick-up place and time. */
export function carLabelOf(
  offer: Offer,
  timeZone: string,
  locale: string,
  hiddenDriver: string,
): string {
  const when = offer.departureAt
    ? formatDateTime(offer.departureAt, { locale, timeZone, timeStyle: "short" })
    : null;
  return [
    offer.driver ? personLabel(offer.driver) : hiddenDriver,
    [offer.departurePlace, when].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
}

async function carLabel(offer: Offer, timeZone: string): Promise<string> {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  return carLabelOf(offer, timeZone, locale, t("carpool.hiddenDriver"));
}

export async function RideButtons({
  activityId,
  personId,
  carpool,
  timeZone,
}: {
  activityId: string;
  personId: string;
  carpool: CarpoolSummary | undefined;
  timeZone: string;
}) {
  if (!carpool) return null;
  const t = await getTranslations();
  const directions = (["out", "back"] as const).map((direction) => ({
    direction,
    booked: carpool.bookings.find(
      (b) => b.passengerPersonId === personId && b.direction === direction,
    ),
    cars: carsFor(carpool, personId, direction),
  }));
  if (directions.every((d) => !d.booked && d.cars.length === 0)) return null;
  const labelOf = (direction: "out" | "back") =>
    direction === "out" ? t("carpool.rideOut") : t("carpool.rideHome");

  return (
    <span className="flex flex-wrap items-center gap-2" data-testid={`rides-${personId}`}>
      {await Promise.all(
        directions.map(async ({ direction, booked, cars }) => {
          if (booked) {
            const offer = carpool.offers.find((o) => o.id === booked.offerId);
            return (
              <span
                key={direction}
                className="flex items-center gap-1 text-xs"
                data-testid={`ride-booked-${direction}`}
              >
                {t(direction === "out" ? "carpool.ridingOut" : "carpool.ridingHome", {
                  car: offer ? await carLabel(offer, timeZone) : "",
                })}
                {booked.status === "pending_guardian" ? ` (${t("carpool.pending")})` : null}
                {booked.canCancel ? (
                  <ActionForm action="carpool-cancel" className="inline">
                    <input type="hidden" name="activityId" value={activityId} />
                    <input type="hidden" name="offerId" value={booked.offerId} />
                    <input type="hidden" name="bookingId" value={booked.id} />
                    <button
                      type="submit"
                      className="underline"
                      data-testid={`ride-cancel-${direction}`}
                    >
                      {t("carpool.cancel")}
                    </button>
                  </ActionForm>
                ) : null}
              </span>
            );
          }
          if (cars.length === 0) return null;
          const book = async (offer: Offer, label: string) => (
            <ActionForm key={offer.id} action="carpool-book" className="inline">
              <input type="hidden" name="activityId" value={activityId} />
              <input type="hidden" name="offerId" value={offer.id} />
              <input type="hidden" name="passengerPersonId" value={personId} />
              <button
                type="submit"
                className={small}
                title={await carLabel(offer, timeZone)}
                data-testid={`ride-book-${direction}`}
              >
                {label}
              </button>
            </ActionForm>
          );
          if (cars.length === 1) return book(cars[0]!, labelOf(direction));
          return (
            <details key={direction} className="relative" data-testid={`ride-menu-${direction}`}>
              <summary className={`${small} cursor-pointer list-none`}>
                {labelOf(direction)} ▾
              </summary>
              <span className="absolute z-10 mt-1 flex min-w-56 flex-col gap-1 rounded-md border border-border bg-raised p-2 shadow">
                {await Promise.all(cars.map(async (o) => book(o, await carLabel(o, timeZone))))}
              </span>
            </details>
          );
        }),
      )}
    </span>
  );
}
