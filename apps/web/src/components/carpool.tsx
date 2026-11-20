// SPDX-License-Identifier: AGPL-3.0-only
// An activity's car pool (P2.5, ADR 0048): the cars there and home with
// their free seats and the driver's note; booking a seat for oneself or a
// child (with the seat home); a guardian's confirmation when their child
// would be the only child with one adult (the driver's name is shown here,
// never in a notice); offering a car; the leaders' list of who has no ride.
// Passengers are named only to those the API names them to.
import { enumKey } from "@clubadmin/i18n";
import { type Carpool, type CarpoolOffer, localDate, localTime } from "@clubadmin/shared";
import { personLabel, PersonName, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { getMyCarpoolSettings } from "../server/data.ts";
import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";
import { ClubTime } from "./club-time.tsx";

type Activity = {
  id: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  status: string;
  location: { name: string } | null;
  locationText: string | null;
};

export async function CarpoolSection({
  activity,
  carpool,
}: {
  activity: Activity;
  carpool: Carpool;
}) {
  const t = await getTranslations();
  if (carpool.transportMode === "shared") {
    return (
      <section aria-labelledby="carpool" className="space-y-1" data-testid="carpool">
        <h2 id="carpool" className="text-lg font-semibold">
          {t("carpool.title")}
        </h2>
        <p className="text-sm">{t("carpool.shared")}</p>
      </section>
    );
  }
  // No transport mode and no car yet (P2.7b): "Ordna samåkning" for those who
  // may offer a ride; the first offer starts the car pool.
  const starting = carpool.transportMode !== "own" && carpool.offers.length === 0;
  if (starting && !carpool.canOffer) return null;
  const zone = activity.timeZone;
  const date = localDate(new Date(activity.startsAt), zone);
  const back = `/activities/${activity.id}`;
  const protectedLabel = t("protected.tooltip");
  const out = carpool.offers.filter((o) => o.direction === "out");
  const home = carpool.offers.filter((o) => o.direction === "back");
  const myOut = out.some((o) => o.mine);
  // Shared transport returned above; own or no mode is open until the start (P2.7b).
  const open = activity.status !== "cancelled" && Date.parse(activity.startsAt) > Date.now();
  // The offer form starts from my own defaults (P2.7f), and the way home
  // from the activity's, my, the club's or 15 minutes after the end.
  const mine = open && carpool.canOffer && !myOut ? (await getMyCarpoolSettings()).settings : null;
  const returnAt = new Date(carpool.defaultReturnAt ?? activity.endsAt);

  const car = (o: CarpoolOffer) => {
    return (
      <li
        key={o.id}
        className="space-y-2 rounded-lg border border-border p-3"
        data-testid="carpool-car"
      >
        <p className="flex flex-wrap items-center gap-2">
          {o.driver ? (
            <PersonName person={o.driver} protectedLabel={protectedLabel} />
          ) : (
            <span className="text-muted">{t("carpool.hiddenDriver")}</span>
          )}
          {o.mine ? <RoleBadge label={t("carpool.yourCar")} /> : null}
          {o.willingOnly ? (
            <RoleBadge label={t("carpool.willingOnly")} />
          ) : (
            <span className="text-sm" data-testid="carpool-free">
              {t("carpool.freeSeats", { free: o.freeSeats, seats: o.seats })}
            </span>
          )}
        </p>
        {o.departurePlace || o.departureAt ? (
          <p className="text-sm">
            {t("carpool.departure")}{" "}
            {o.departureAt ? (
              <ClubTime value={o.departureAt} timeZone={zone} timeStyle="short" />
            ) : null}
            {o.departureAt && o.departurePlace ? ", " : null}
            {o.departurePlace}
          </p>
        ) : null}
        {o.note ? (
          <p className="text-sm text-muted" data-testid="carpool-note">
            {o.note}
          </p>
        ) : null}
        {o.bookings.length > 0 ? (
          <ul className="space-y-1 text-sm" data-testid="carpool-bookings">
            {o.bookings.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="carpool-booking"
              >
                {b.passenger ? (
                  <PersonName person={b.passenger} protectedLabel={protectedLabel} />
                ) : (
                  <span className="text-muted">{t("carpool.bookedSeat")}</span>
                )}
                {b.status === "pending_guardian" ? (
                  <RoleBadge tone="accent" label={t("carpool.pending")} />
                ) : null}
                {b.canConfirm ? (
                  <ActionForm action="carpool-confirm">
                    <input type="hidden" name="bookingId" value={b.id} />
                    <input type="hidden" name="back" value={back} />
                    <button
                      type="submit"
                      className={secondaryButtonClass}
                      data-testid="carpool-confirm"
                    >
                      {t("carpool.confirm", { driver: o.driver ? personLabel(o.driver) : "" })}
                    </button>
                  </ActionForm>
                ) : null}
                {b.canCancel ? (
                  <ActionForm action="carpool-cancel">
                    <input type="hidden" name="activityId" value={activity.id} />
                    <input type="hidden" name="offerId" value={o.id} />
                    <input type="hidden" name="bookingId" value={b.id} />
                    <button
                      type="submit"
                      className="text-xs underline"
                      data-testid="carpool-cancel"
                    >
                      {t("carpool.cancel")}
                    </button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {/* One tap per person and direction (P2.7c): "Åk med dit" / "Åk med hem".
            A seat waiting for a guardian's confirmation shows above. */}
        {open && !o.mine && !o.willingOnly ? (
          o.freeSeats > 0 ? (
            <div className="flex flex-wrap gap-2" data-testid="carpool-book-buttons">
              {carpool.canBookFor
                .filter((p) => !o.bookings.some((b) => b.passenger?.id === p.id))
                .map((p) => (
                  <ActionForm key={p.id} action="carpool-book">
                    <input type="hidden" name="activityId" value={activity.id} />
                    <input type="hidden" name="offerId" value={o.id} />
                    <input type="hidden" name="passengerPersonId" value={p.id} />
                    <button
                      type="submit"
                      className={secondaryButtonClass}
                      data-testid="carpool-book"
                    >
                      {o.direction === "out" ? t("carpool.rideOut") : t("carpool.rideHome")}
                      {carpool.canBookFor.length > 1 ? ` – ${personLabel(p)}` : ""}
                    </button>
                  </ActionForm>
                ))}
            </div>
          ) : (
            <p className="text-xs text-muted" data-testid="carpool-full">
              {t("carpool.full")}
            </p>
          )
        ) : null}
        {o.mine ? (
          <details>
            <summary className="cursor-pointer text-sm" data-testid="carpool-edit">
              {t("carpool.edit")}
            </summary>
            <ActionForm action="carpool-update" className="mt-2 space-y-2">
              <input type="hidden" name="activityId" value={activity.id} />
              <input type="hidden" name="offerId" value={o.id} />
              <input type="hidden" name="timeZone" value={zone} />
              <input type="hidden" name="date" value={date} />
              {open ? (
                <OfferFields
                  seats={o.willingOnly ? null : o.seats}
                  place={o.departurePlace}
                  time={o.departureAt ? localTime(new Date(o.departureAt), zone) : ""}
                  note={o.note}
                />
              ) : null}
              <label className="block space-y-1">
                <span className="text-sm">{t("carpool.distance")}</span>
                <input
                  type="number"
                  name="distanceKm"
                  min={0}
                  max={5000}
                  step="0.1"
                  defaultValue={o.distanceKm ?? ""}
                  className={inputClass}
                />
              </label>
              <button type="submit" className={buttonClass}>
                {t("carpool.save")}
              </button>
            </ActionForm>
            {open ? (
              <ActionForm action="carpool-delete" className="mt-2">
                <input type="hidden" name="activityId" value={activity.id} />
                <input type="hidden" name="offerId" value={o.id} />
                <button type="submit" className={secondaryButtonClass} data-testid="carpool-delete">
                  {t("carpool.remove")}
                </button>
              </ActionForm>
            ) : null}
          </details>
        ) : null}
      </li>
    );
  };

  return (
    <section aria-labelledby="carpool" className="space-y-3" data-testid="carpool">
      <h2 id="carpool" className="text-lg font-semibold">
        {t("carpool.title")}
      </h2>
      {carpool.distanceKm !== null ? (
        <p className="text-sm text-muted">
          {t("carpool.placeDistance", { km: carpool.distanceKm })}
        </p>
      ) : null}
      {(["out", "back"] as const).map((direction) => {
        const cars = direction === "out" ? out : home;
        return (
          <div key={direction} className="space-y-2">
            <h3 className="text-sm font-semibold">{t(enumKey("carpool.directions", direction))}</h3>
            {cars.length === 0 ? (
              <p className="text-sm text-muted">{t("carpool.noCars")}</p>
            ) : (
              <ul className="space-y-2">{cars.map(car)}</ul>
            )}
          </div>
        );
      })}
      {carpool.withoutRide && !starting ? (
        <div data-testid="carpool-without-ride">
          <h3 className="text-sm font-semibold">{t("carpool.withoutRide")}</h3>
          {carpool.withoutRide.length === 0 && carpool.withoutRideHidden === 0 ? (
            <p className="text-sm text-muted">{t("carpool.everyoneHasRide")}</p>
          ) : (
            <p className="text-sm">
              {carpool.withoutRide.map((p) => personLabel(p)).join(", ")}
              {carpool.withoutRideHidden > 0
                ? ` ${t("carpool.hiddenCount", { count: carpool.withoutRideHidden })}`
                : null}
            </p>
          )}
        </div>
      ) : null}
      {/* Why no seat can be booked (P2.7c). */}
      {!open ? (
        <p className="text-sm text-muted" data-testid="carpool-why">
          {t("carpool.startedNoBooking")}
        </p>
      ) : carpool.canBookFor.length === 0 && carpool.offers.some((o) => !o.mine) ? (
        <p className="text-sm text-muted" data-testid="carpool-why">
          {carpool.selfBookingAge !== undefined
            ? t("carpool.tooYoungToBook", { age: carpool.selfBookingAge })
            : t("carpool.notTakingPart")}
        </p>
      ) : null}
      {open && carpool.canOffer && !myOut ? (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-medium" data-testid="carpool-offer">
            {starting ? t("carpool.start") : t("carpool.offer")}
          </summary>
          <ActionForm action="carpool-offer" className="mt-2 space-y-2" testId="carpool-offer-form">
            <input type="hidden" name="activityId" value={activity.id} />
            <input type="hidden" name="timeZone" value={zone} />
            <input type="hidden" name="date" value={date} />
            <OfferFields
              seats={mine?.seats ?? 3}
              place={mine?.departurePlace ?? null}
              time=""
              note={mine?.note ?? null}
            />
            <fieldset className="space-y-2 rounded-md border border-border p-2">
              <legend className="px-1 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="withReturn" defaultChecked />
                  {t("carpool.withReturn")}
                </label>
              </legend>
              {/* The way home has its own place and time (P2.7c), prefilled
                  with the activity's place and its end. */}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm">{t("carpool.returnDeparturePlace")}</span>
                  <input
                    name="returnDeparturePlace"
                    maxLength={200}
                    defaultValue={activity.location?.name ?? activity.locationText ?? ""}
                    className={inputClass}
                    data-testid="carpool-return-place"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">{t("carpool.returnDepartureTime")}</span>
                  <input
                    type="time"
                    name="returnDepartureTime"
                    defaultValue={localTime(returnAt, zone)}
                    className={inputClass}
                    data-testid="carpool-return-time"
                  />
                </label>
              </div>
              <input type="hidden" name="returnDate" value={localDate(returnAt, zone)} />
            </fieldset>
            <button type="submit" className={buttonClass} data-testid="carpool-offer-submit">
              {t("carpool.offerSubmit")}
            </button>
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}

async function OfferFields({
  seats,
  place,
  time,
  note,
}: {
  seats: number | null;
  place: string | null;
  time: string;
  note: string | null;
}) {
  const t = await getTranslations();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="block space-y-1">
        <span className="text-sm">{t("carpool.seats")}</span>
        <input
          type="number"
          name="seats"
          min={1}
          max={8}
          defaultValue={seats ?? ""}
          className={inputClass}
          data-testid="carpool-seats"
        />
      </label>
      <label className="flex items-center gap-2 self-end text-sm">
        <input type="checkbox" name="willingOnly" defaultChecked={seats === null} />
        {t("carpool.willingOnlyLabel")}
      </label>
      <label className="block space-y-1">
        <span className="text-sm">{t("carpool.departurePlace")}</span>
        <input
          name="departurePlace"
          maxLength={200}
          defaultValue={place ?? ""}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">{t("carpool.departureTime")}</span>
        <input type="time" name="departureTime" defaultValue={time} className={inputClass} />
      </label>
      <label className="block space-y-1 sm:col-span-2">
        <span className="text-sm">{t("carpool.note")}</span>
        <input
          name="note"
          maxLength={300}
          defaultValue={note ?? ""}
          placeholder={t("carpool.notePlaceholder")}
          className={inputClass}
          data-testid="carpool-note-input"
        />
      </label>
    </div>
  );
}
