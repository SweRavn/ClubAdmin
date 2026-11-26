// SPDX-License-Identifier: AGPL-3.0-only
// An activity's car pool (P2.5, ADR 0048), below its details when the group
// travels on its own: the cars there and home with free seats, departure and
// the driver's note, the seats booked (named only for those who may see
// them), booking a seat for oneself or a child, cancelling, and offering
// seats in one's own car. A child's seat that needs a guardian's confirmation
// (the rule of two) is confirmed in "Mina samåkningar", where the driver's
// name is shown. Cache first: the cached car pool shows at once. Since
// P2.7g as on the web: the departure and return times, the offer starting
// from my defaults, changing and removing my car, why a seat cannot be
// booked, and "Skapa samåkning" in one tap.

import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { useState } from "react";
import { Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  type Carpool,
  type CarpoolOffer,
  type CarpoolSummary,
  type PersonalCarpoolSettings,
  useBookCarpoolSeat,
  useCancelCarpoolSeat,
  useDeleteCarpoolOffer,
  useMyCarpoolSettings,
  useOfferCarpool,
  useQuickCarpool,
  useUpdateCarpoolOffer,
} from "../api/queries.ts";
import { useTheme } from "../theme.ts";
import { defaultReturnTime, timeOnDay } from "./activity-logic.ts";
import {
  DateTimeField,
  FormError,
  formErrorsOf,
  SwitchField,
  TextField,
  useOnline,
} from "./form.tsx";
import { PersonName } from "./person-name.tsx";
import { RoleBadge } from "./role-badge.tsx";
import { Body, Button, Muted, Row, Section } from "./ui.tsx";

const DIRECTIONS = ["out", "back"] as const;

export function CarpoolSection({
  activityId,
  carpool,
  timeZone,
  open,
  returnTrip = { place: null, at: null },
  startsAt,
}: {
  activityId: string;
  carpool: Carpool;
  timeZone: string;
  /** The activity has not started and is not cancelled. */
  open: boolean;
  /** Where and when the way home starts by default: the activity's place and end (P2.7c). */
  returnTrip?: { place: string | null; at: string | null };
  /** The activity's start: times are entered on its day (P2.7g). */
  startsAt?: string;
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
      <OfferForm
        activityId={activityId}
        title={t("carpool.start")}
        carpool={carpool}
        timeZone={timeZone}
        returnTrip={returnTrip}
        startsAt={startsAt ?? null}
      />
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
                  startsAt={startsAt ?? null}
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
      {/* Why no seat can be booked (P2.7c; the age from which one books oneself, P2.7f). */}
      {!open ? (
        <Muted testID="carpool-why">{t("carpool.startedNoBooking")}</Muted>
      ) : carpool.canBookFor.length === 0 && carpool.offers.some((o) => !o.mine) ? (
        <Muted testID="carpool-why">
          {carpool.selfBookingAge !== undefined
            ? t("carpool.tooYoungToBook", { age: carpool.selfBookingAge })
            : t("carpool.notTakingPart")}
        </Muted>
      ) : null}
      {open && carpool.canOffer && !myOut ? (
        <OfferForm
          activityId={activityId}
          carpool={carpool}
          timeZone={timeZone}
          returnTrip={returnTrip}
          startsAt={startsAt ?? null}
        />
      ) : null}
    </>
  );
}

function Car({
  activityId,
  offer,
  carpool,
  timeZone,
  open,
  startsAt,
  last,
}: {
  activityId: string;
  offer: CarpoolOffer;
  carpool: Carpool;
  timeZone: string;
  open: boolean;
  startsAt: string | null;
  last: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const book = useBookCarpoolSeat(activityId);
  const cancel = useCancelCarpoolSeat(activityId);
  const [editing, setEditing] = useState(false);
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
      {open && offer.mine ? (
        editing ? (
          <EditCar
            activityId={activityId}
            offer={offer}
            timeZone={timeZone}
            startsAt={startsAt}
            onDone={() => setEditing(false)}
          />
        ) : (
          <Button
            kind="secondary"
            label={t("carpool.edit")}
            onPress={() => setEditing(true)}
            testID={`carpool-edit-${offer.direction}`}
          />
        )
      ) : null}
    </Row>
  );
}

/** My car's seats, time, place and note; or removing it (its passengers are told). */
function EditCar({
  activityId,
  offer,
  timeZone,
  startsAt,
  onDone,
}: {
  activityId: string;
  offer: CarpoolOffer;
  timeZone: string;
  startsAt: string | null;
  onDone: () => void;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const online = useOnline();
  const update = useUpdateCarpoolOffer(activityId);
  const remove = useDeleteCarpoolOffer(activityId);
  const [seats, setSeats] = useState(Math.max(1, offer.seats));
  const [time, setTime] = useState(
    offer.departureAt ? defaultReturnTime(offer.departureAt, null, timeZone) : "",
  );
  const [place, setPlace] = useState(offer.departurePlace ?? "");
  const [note, setNote] = useState(offer.note ?? "");
  const errors = formErrorsOf(update.error ?? remove.error);
  return (
    <View style={{ gap: theme.space(2) }} testID="carpool-edit-form">
      {offer.willingOnly ? null : <SeatsStepper seats={seats} onChange={setSeats} />}
      <DateTimeField
        label={t("carpool.departureTime")}
        mode="time"
        name="carpool-edit-time"
        optional
        value={time}
        onChange={setTime}
        error={errors.fields.departureAt}
      />
      <TextField
        label={t("carpool.departurePlace")}
        name="carpool-edit-place"
        value={place}
        onChange={setPlace}
        maxLength={200}
        error={errors.fields.departurePlace}
      />
      <TextField
        label={t("carpool.note")}
        name="carpool-edit-note"
        value={note}
        onChange={setNote}
        maxLength={300}
        error={errors.fields.note}
      />
      <FormError errors={errors} />
      {online ? null : <Muted>{t("mobile.needsConnection")}</Muted>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button
          label={t("carpool.save")}
          disabled={!online}
          busy={update.isPending}
          onPress={() =>
            update.mutate(
              {
                offerId: offer.id,
                ...(offer.willingOnly ? {} : { seats }),
                departurePlace: place.trim() || null,
                note: note.trim() || null,
                departureAt: startsAt ? timeOnDay(time, startsAt, timeZone) : null,
              },
              { onSuccess: onDone },
            )
          }
          testID="carpool-edit-save"
        />
        <Button
          kind="danger"
          label={t("carpool.remove")}
          disabled={!online}
          busy={remove.isPending}
          onPress={() => remove.mutate(offer.id, { onSuccess: onDone })}
          testID="carpool-remove"
        />
      </View>
    </View>
  );
}

function SeatsStepper({ seats, onChange }: { seats: number; onChange: (seats: number) => void }) {
  const t = useTranslations();
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space(1) }}>
      <Muted>{t("carpool.seats")}</Muted>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(2) }}>
        <Button
          kind="secondary"
          label="−"
          disabled={seats <= 1}
          onPress={() => onChange(seats - 1)}
          testID="carpool-seats-less"
        />
        <Body>{String(seats)}</Body>
        <Button
          kind="secondary"
          label="+"
          disabled={seats >= 8}
          onPress={() => onChange(seats + 1)}
          testID="carpool-seats-more"
        />
      </View>
    </View>
  );
}

/** Offering seats; starts from my defaults once they are loaded. */
function OfferForm(props: {
  activityId: string;
  title?: string;
  carpool: Carpool;
  timeZone: string;
  returnTrip: { place: string | null; at: string | null };
  startsAt: string | null;
}) {
  const settings = useMyCarpoolSettings();
  if (settings.isPending && !settings.isError) return null;
  return <OfferFields {...props} defaults={settings.data?.settings ?? null} />;
}

function OfferFields({
  activityId,
  title,
  carpool,
  timeZone,
  returnTrip,
  startsAt,
  defaults,
}: {
  activityId: string;
  title?: string;
  carpool: Carpool;
  timeZone: string;
  returnTrip: { place: string | null; at: string | null };
  startsAt: string | null;
  defaults: PersonalCarpoolSettings | null;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const online = useOnline();
  const offer = useOfferCarpool(activityId);
  const [seats, setSeats] = useState(defaults?.seats ?? 3);
  const [time, setTime] = useState("");
  const [place, setPlace] = useState(defaults?.departurePlace ?? "");
  const [note, setNote] = useState(defaults?.note ?? "");
  const [withReturn, setWithReturn] = useState(true);
  // The way home starts at the activity's place (P2.7c), at the activity's,
  // my, the club's or 15 minutes after the end (P2.7f, `defaultReturnAt`).
  const [returnPlace, setReturnPlace] = useState(returnTrip.place ?? "");
  const [returnTime, setReturnTime] = useState(
    defaultReturnTime(
      carpool.defaultReturnAt,
      returnTrip.at,
      timeZone,
      defaults?.returnMinutes ?? 15,
    ),
  );
  const quick = useQuickCarpool();
  const errors = formErrorsOf(offer.error ?? quick.error);
  const day = startsAt ?? returnTrip.at;
  return (
    <Section title={title ?? t("carpool.offer")}>
      <View style={{ gap: theme.space(2), paddingVertical: theme.space(2) }}>
        {/* With my defaults: there and home in one tap (P2.7f), or the details below. */}
        {defaults ? (
          <Button
            label={t("carpool.quick", { seats: defaults.seats })}
            disabled={!online}
            busy={quick.isPending}
            onPress={() =>
              quick.mutate({ activityId, settings: defaults, returnPlace: returnTrip.place })
            }
            testID={`carpool-quick-${activityId}`}
          />
        ) : null}
        <SeatsStepper seats={seats} onChange={setSeats} />
        <DateTimeField
          label={t("carpool.departureTime")}
          mode="time"
          name="carpool-time"
          optional
          value={time}
          onChange={setTime}
          error={errors.fields.departureAt}
        />
        <TextField
          label={t("carpool.departurePlace")}
          name="carpool-place"
          value={place}
          onChange={setPlace}
          maxLength={200}
          error={errors.fields.departurePlace}
        />
        <TextField
          label={t("carpool.note")}
          name="carpool-note"
          value={note}
          onChange={setNote}
          maxLength={300}
          placeholder={t("carpool.notePlaceholder")}
          error={errors.fields.note}
        />
        <SwitchField
          label={t("carpool.withReturn")}
          name="carpool-with-return"
          value={withReturn}
          onChange={setWithReturn}
        />
        {withReturn ? (
          <>
            <DateTimeField
              label={t("carpool.returnDepartureTime")}
              mode="time"
              name="carpool-return-time"
              optional
              value={returnTime}
              onChange={setReturnTime}
              error={errors.fields.returnDepartureAt}
            />
            <TextField
              label={t("carpool.returnDeparturePlace")}
              name="carpool-return-place"
              value={returnPlace}
              onChange={setReturnPlace}
              maxLength={200}
              error={errors.fields.returnDeparturePlace}
            />
          </>
        ) : null}
        <FormError errors={errors} />
        {online ? null : <Muted>{t("mobile.needsConnection")}</Muted>}
        <Button
          label={t("carpool.offerSubmit")}
          disabled={!online}
          busy={offer.isPending}
          onPress={() =>
            offer.mutate({
              direction: "out",
              willingOnly: false,
              seats,
              departurePlace: place.trim() || null,
              departureAt: day ? timeOnDay(time, day, timeZone) : null,
              note: note.trim() || null,
              withReturn,
              ...(withReturn
                ? {
                    returnDeparturePlace: returnPlace.trim() || null,
                    returnDepartureAt: day ? timeOnDay(returnTime, day, timeZone, startsAt) : null,
                  }
                : {}),
            })
          }
          testID="carpool-offer-submit"
        />
      </View>
    </Section>
  );
}

/**
 * "Skapa samåkning" (P2.7f): my car there and home with my defaults, one
 * tap; for those with defaults where the car pool takes offers and I have
 * no car yet. The way home's time is the API's (`defaultReturnAt`).
 */
export function CarpoolQuickButton({
  activityId,
  summary,
  settings,
  returnPlace,
}: {
  activityId: string;
  summary: CarpoolSummary | undefined;
  settings: PersonalCarpoolSettings | null | undefined;
  returnPlace: string | null;
}) {
  const t = useTranslations();
  const quick = useQuickCarpool();
  const online = useOnline();
  if (!settings || !summary?.open || summary.canOffer !== true) return null;
  if (summary.offers.some((o) => o.mine)) return null;
  return (
    <Button
      kind="secondary"
      label={t("carpool.quick", { seats: settings.seats })}
      disabled={!online}
      busy={quick.isPending}
      onPress={() => quick.mutate({ activityId, settings, returnPlace })}
      testID={`carpool-quick-${activityId}`}
    />
  );
}
