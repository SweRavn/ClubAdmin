// SPDX-License-Identifier: AGPL-3.0-only
// A seat in a car from "Mitt schema" (P2.7c, ADR 0048): per person, the
// cars there and home with a free seat (driver, pick-up place and time) as
// buttons, one tap books; a booked seat says whose car it is and can be
// cancelled. The data comes from the club's car pool summaries.

import { personLabel } from "@clubadmin/shared";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { type CarpoolSummary, useBookCarpoolSeat, useCancelCarpoolSeat } from "../api/queries.ts";
import { useTheme } from "../theme.ts";
import { Button, Muted } from "./ui.tsx";

type Offer = CarpoolSummary["offers"][number];

/** The cars a person may take in one direction: free seats, not their own. */
export function carsFor(
  carpool: CarpoolSummary | undefined,
  personId: string,
  direction: "out" | "back",
): Offer[] {
  if (!carpool?.open || !carpool.canBookFor.some((p) => p.id === personId)) return [];
  return carpool.offers.filter((o) => o.direction === direction && !o.mine && o.freeSeats > 0);
}

/** "Mikael Lindqvist · Strandviksskolan 08:45". */
export function useCarText() {
  const t = useTranslations();
  const format = useFormatter();
  return (offer: Offer, timeZone: string) =>
    [
      offer.driver ? personLabel(offer.driver) : t("carpool.hiddenDriver"),
      [
        offer.departurePlace,
        offer.departureAt
          ? format.dateTime(new Date(offer.departureAt), { timeStyle: "short", timeZone })
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    ]
      .filter(Boolean)
      .join(" · ");
}

export function RideChoices({
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
  const t = useTranslations();
  const theme = useTheme();
  const book = useBookCarpoolSeat(activityId);
  const cancel = useCancelCarpoolSeat(activityId);
  const carText = useCarText();
  if (!carpool) return null;
  const rows = (["out", "back"] as const).flatMap((direction) => {
    const booked = carpool.bookings.find(
      (b) => b.passengerPersonId === personId && b.direction === direction,
    );
    if (booked) {
      const offer = carpool.offers.find((o) => o.id === booked.offerId);
      return [
        <View
          key={direction}
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: theme.space(2),
          }}
        >
          <Muted>
            {t(direction === "out" ? "carpool.ridingOut" : "carpool.ridingHome", {
              car: offer ? carText(offer, timeZone) : "",
            })}
          </Muted>
          {booked.canCancel ? (
            <Button
              kind="secondary"
              label={t("carpool.cancel")}
              busy={cancel.isPending}
              onPress={() => cancel.mutate({ offerId: booked.offerId, bookingId: booked.id })}
              testID={`ride-cancel-${direction}-${activityId}-${personId}`}
            />
          ) : null}
        </View>,
      ];
    }
    return carsFor(carpool, personId, direction).map((offer) => (
      <Button
        key={offer.id}
        kind="secondary"
        label={`${direction === "out" ? t("carpool.rideOut") : t("carpool.rideHome")}: ${carText(offer, timeZone)}`}
        busy={book.isPending}
        onPress={() =>
          book.mutate({
            offerId: offer.id,
            passengerPersonId: personId,
            alsoReturn: false,
            confirmAlone: false,
          })
        }
        testID={`ride-book-${direction}-${offer.id}-${personId}`}
      />
    ));
  });
  return rows.length > 0 ? <View style={{ gap: theme.space(1) }}>{rows}</View> : null;
}
