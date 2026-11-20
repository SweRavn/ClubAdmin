// SPDX-License-Identifier: AGPL-3.0-only
// A seat in a car from the schedule and the group's list (P2.7c, P2.7d,
// ADR 0048): one menu only. Before answering, "Kommer ▾" in the answer
// buttons lists the cars; after answering "Kommer", "Åk med ▾" here does.
// Choosing a car books the way there and, when the same car drives home
// with a free seat, the way home too. A booked seat says whose car it is and
// can be cancelled. The data is the club's car pool summaries (one request
// per club and page).
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

/** Whether the car there also takes the person home (its return trip has a free seat). */
export function drivesHome(carpool: CarpoolSummary, outward: Offer): boolean {
  return carpool.offers.some(
    (o) => o.direction === "back" && o.outwardOfferId === outward.id && o.freeSeats > 0,
  );
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

/** The menu's line for a car: who, where, when, and whether it brings the person home. */
export function rideLabel(
  carpool: CarpoolSummary,
  offer: Offer,
  timeZone: string,
  locale: string,
  texts: { hiddenDriver: string; thereAndHome: string; thereOnly: string },
): string {
  return `${carLabelOf(offer, timeZone, locale, texts.hiddenDriver)} (${
    drivesHome(carpool, offer) ? texts.thereAndHome : texts.thereOnly
  })`;
}

/**
 * The person's seats, and "Åk med ▾" once they have answered "Kommer"
 * without a seat there. Before answering the "Kommer" menu offers the cars.
 */
export async function RideButtons({
  activityId,
  personId,
  carpool,
  timeZone,
  attending,
}: {
  activityId: string;
  personId: string;
  carpool: CarpoolSummary | undefined;
  timeZone: string;
  /** The person answered "Kommer" (the menu is here, not in the answer buttons). */
  attending: boolean;
}) {
  if (!carpool) return null;
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const booked = carpool.bookings.filter((b) => b.passengerPersonId === personId);
  const bookedOut = booked.some((b) => b.direction === "out");
  const cars = attending && !bookedOut ? carsFor(carpool, personId, "out") : [];
  if (booked.length === 0 && cars.length === 0) return null;
  const texts = {
    hiddenDriver: t("carpool.hiddenDriver"),
    thereAndHome: t("carpool.thereAndHome"),
    thereOnly: t("carpool.thereOnly"),
  };

  return (
    <span className="flex flex-wrap items-center gap-2" data-testid={`rides-${personId}`}>
      {booked.map((b) => {
        const offer = carpool.offers.find((o) => o.id === b.offerId);
        return (
          <span
            key={b.id}
            className="flex items-center gap-1 text-xs"
            data-testid={`ride-booked-${b.direction}`}
          >
            {t(b.direction === "out" ? "carpool.ridingOut" : "carpool.ridingHome", {
              car: offer ? carLabelOf(offer, timeZone, locale, texts.hiddenDriver) : "",
            })}
            {b.status === "pending_guardian" ? ` (${t("carpool.pending")})` : null}
            {b.canCancel ? (
              <ActionForm action="carpool-cancel" className="inline">
                <input type="hidden" name="activityId" value={activityId} />
                <input type="hidden" name="offerId" value={b.offerId} />
                <input type="hidden" name="bookingId" value={b.id} />
                <button
                  type="submit"
                  className="underline"
                  data-testid={`ride-cancel-${b.direction}`}
                >
                  {t("carpool.cancel")}
                </button>
              </ActionForm>
            ) : null}
          </span>
        );
      })}
      {cars.length > 0 ? (
        <details className="relative" data-testid="ride-menu">
          <summary className={`${small} cursor-pointer list-none`}>
            {t("carpool.rideWith")} ▾
          </summary>
          <span className="absolute z-10 mt-1 flex min-w-64 flex-col gap-1 rounded-md border border-border bg-raised p-2 shadow">
            {cars.map((o) => (
              <ActionForm key={o.id} action="carpool-book">
                <input type="hidden" name="activityId" value={activityId} />
                <input type="hidden" name="offerId" value={o.id} />
                <input type="hidden" name="passengerPersonId" value={personId} />
                <input type="hidden" name="alsoReturn" value="on" />
                <button
                  type="submit"
                  className="w-full rounded px-2 py-1 text-left text-sm hover:bg-surface"
                  data-testid="ride-book"
                >
                  {rideLabel(carpool, o, timeZone, locale, texts)}
                </button>
              </ActionForm>
            ))}
          </span>
        </details>
      ) : null}
    </span>
  );
}
