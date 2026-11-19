// SPDX-License-Identifier: AGPL-3.0-only
// An activity's car pool (P2.5, ADR 0048), below its details when the group
// travels on its own: the cars there and home with free seats, departure and
// the driver's note, the seats booked (named only for those who may see
// them), booking a seat for oneself or a child, cancelling, and offering
// seats in one's own car. A child's seat that needs a guardian's confirmation
// (the rule of two) is confirmed in "Mina samåkningar", where the driver's
// name is shown. Cache first: the cached car pool shows at once.

import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  type Carpool,
  type CarpoolOffer,
  useBookCarpoolSeat,
  useCancelCarpoolSeat,
  useOfferCarpool,
} from "../api/queries.ts";
import { useTheme } from "../theme.ts";
import { PersonName } from "./person-name.tsx";
import { RoleBadge } from "./role-badge.tsx";
import { Body, Button, Muted, Row, Section } from "./ui.tsx";

const DIRECTIONS = ["out", "back"] as const;

export function CarpoolSection({
  activityId,
  carpool,
  timeZone,
  open,
}: {
  activityId: string;
  carpool: Carpool;
  timeZone: string;
  /** The activity has not started and is not cancelled. */
  open: boolean;
}) {
  const t = useTranslations();
  if (carpool.transportMode === "shared") {
    return (
      <Section title={t("carpool.title")}>
        <Row last>
          <Body>{t("carpool.shared")}</Body>
        </Row>
      </Section>
    );
  }
  // No transport mode and no car yet (P2.7b): the offer form starts the car pool.
  if (carpool.transportMode !== "own" && carpool.offers.length === 0) {
    return open && carpool.canOffer ? (
      <OfferForm activityId={activityId} title={t("carpool.start")} />
    ) : null;
  }
  const myOut = carpool.offers.some((o) => o.mine && o.direction === "out");
  return (
    <>
      {DIRECTIONS.map((direction) => {
        const cars = carpool.offers.filter((o) => o.direction === direction);
        return (
          <Section
            key={direction}
            title={`${t("carpool.title")} · ${t(enumKey("carpool.directions", direction))}`}
          >
            {cars.length === 0 ? (
              <Row last>
                <Muted>{t("carpool.noCars")}</Muted>
              </Row>
            ) : (
              cars.map((offer, index) => (
                <Car
                  key={offer.id}
                  activityId={activityId}
                  offer={offer}
                  carpool={carpool}
                  timeZone={timeZone}
                  open={open}
                  last={index === cars.length - 1}
                />
              ))
            )}
          </Section>
        );
      })}
      {carpool.withoutRide ? (
        <Section title={t("carpool.withoutRide")}>
          <Row last testID="carpool-without-ride">
            {carpool.withoutRide.length === 0 && carpool.withoutRideHidden === 0 ? (
              <Muted>{t("carpool.everyoneHasRide")}</Muted>
            ) : (
              <Body>
                {carpool.withoutRide.map((p) => personLabel(p)).join(", ")}
                {carpool.withoutRideHidden > 0
                  ? ` ${t("carpool.hiddenCount", { count: carpool.withoutRideHidden })}`
                  : ""}
              </Body>
            )}
          </Row>
        </Section>
      ) : null}
      {open && carpool.canOffer && !myOut ? <OfferForm activityId={activityId} /> : null}
    </>
  );
}

function Car({
  activityId,
  offer,
  carpool,
  timeZone,
  open,
  last,
}: {
  activityId: string;
  offer: CarpoolOffer;
  carpool: Carpool;
  timeZone: string;
  open: boolean;
  last: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const book = useBookCarpoolSeat(activityId);
  const cancel = useCancelCarpoolSeat(activityId);
  const booked = new Set(offer.bookings.flatMap((b) => (b.passenger ? [b.passenger.id] : [])));
  const bookable = open && !offer.mine && offer.freeSeats > 0 && !offer.willingOnly;
  return (
    <Row last={last} testID="carpool-car">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) }}>
        {offer.driver ? (
          <PersonName person={offer.driver} />
        ) : (
          <Muted>{t("carpool.hiddenDriver")}</Muted>
        )}
        {offer.mine ? <RoleBadge label={t("carpool.yourCar")} /> : null}
        {offer.willingOnly ? <RoleBadge label={t("carpool.willingOnly")} /> : null}
      </View>
      {offer.willingOnly ? null : (
        <Muted>{t("carpool.freeSeats", { free: offer.freeSeats, seats: offer.seats })}</Muted>
      )}
      {offer.departurePlace || offer.departureAt ? (
        <Muted>
          {`${t("carpool.departure")} ${[
            offer.departureAt
              ? format.dateTime(new Date(offer.departureAt), { timeStyle: "short", timeZone })
              : null,
            offer.departurePlace,
          ]
            .filter(Boolean)
            .join(", ")}`}
        </Muted>
      ) : null}
      {offer.note ? <Body>{offer.note}</Body> : null}
      {offer.bookings.map((b) => (
        <View
          key={b.id}
          style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}
          testID="carpool-booking"
        >
          {b.passenger ? (
            <PersonName person={b.passenger} />
          ) : (
            <Text style={{ color: theme.colors.muted }}>{t("carpool.bookedSeat")}</Text>
          )}
          {b.status === "pending_guardian" ? (
            <RoleBadge tone="accent" label={t("carpool.pending")} />
          ) : null}
          {open && b.canCancel ? (
            <Button
              kind="secondary"
              label={t("carpool.cancel")}
              busy={cancel.isPending && cancel.variables?.bookingId === b.id}
              onPress={() => cancel.mutate({ offerId: offer.id, bookingId: b.id })}
              testID={`carpool-cancel-${b.id}`}
            />
          ) : null}
        </View>
      ))}
      {bookable
        ? carpool.canBookFor
            .filter((p) => !booked.has(p.id))
            .map((p) => (
              <Button
                key={p.id}
                kind="secondary"
                label={`${t("carpool.book")}: ${personLabel(p)}`}
                busy={book.isPending && book.variables?.passengerPersonId === p.id}
                onPress={() =>
                  book.mutate({
                    offerId: offer.id,
                    passengerPersonId: p.id,
                    alsoReturn: false,
                    confirmAlone: false,
                  })
                }
                testID={`carpool-book-${offer.id}-${p.id}`}
              />
            ))
        : null}
    </Row>
  );
}

function OfferForm({ activityId, title }: { activityId: string; title?: string }) {
  const t = useTranslations();
  const theme = useTheme();
  const offer = useOfferCarpool(activityId);
  const [seats, setSeats] = useState(3);
  const [note, setNote] = useState("");
  const [withReturn, setWithReturn] = useState(true);
  return (
    <Section title={title ?? t("carpool.offer")}>
      <Row>
        <Muted>{t("carpool.seats")}</Muted>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(2) }}>
          <Button
            kind="secondary"
            label="−"
            disabled={seats <= 1}
            onPress={() => setSeats(seats - 1)}
            testID="carpool-seats-less"
          />
          <Body>{String(seats)}</Body>
          <Button
            kind="secondary"
            label="+"
            disabled={seats >= 8}
            onPress={() => setSeats(seats + 1)}
            testID="carpool-seats-more"
          />
        </View>
      </Row>
      <Row>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder={t("carpool.notePlaceholder")}
          accessibilityLabel={t("carpool.note")}
          maxLength={300}
          testID="carpool-note"
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            padding: theme.space(3),
            color: theme.colors.fg,
          }}
        />
      </Row>
      <Row>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(2) }}>
          <Switch
            value={withReturn}
            onValueChange={setWithReturn}
            accessibilityLabel={t("carpool.withReturn")}
          />
          <Body>{t("carpool.withReturn")}</Body>
        </View>
      </Row>
      <Row last>
        <Button
          label={t("carpool.offerSubmit")}
          busy={offer.isPending}
          onPress={() =>
            offer.mutate({
              direction: "out",
              willingOnly: false,
              seats,
              note: note.trim() === "" ? null : note.trim(),
              withReturn,
            })
          }
          testID="carpool-offer-submit"
        />
      </Row>
    </Section>
  );
}
