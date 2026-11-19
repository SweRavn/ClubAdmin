# 0048 — Car pooling, mileage and a general attestation flow

**Status:** Accepted (decided 2026-11-12, before the Phase 2 car-pool prompt)

**Context.** Teams travel to matches, cups and sometimes trainings far away.
Parents drive; some clubs rent a bus. Drivers want to share costs or be
reimbursed by the club, and clubs need the mileage to pay it. Safeguarding
practice in sport (SafeSport and others, ADR 0047) treats an adult alone in
a car with a child who is not their own as a risk. Activities already have a
meeting time and place, and locations have coordinates (ADR 0034).

**Decision.**

1. **Transport per activity.** Whoever creates an activity (or a series,
   inherited by its sessions; or an event's session) chooses: not set (no
   car pool shown), **own transport** ("Deltagarna tar sig dit själva":
   meeting time and place required, the car pool opens) or **shared
   transport** (e.g. a rented bus: only the meeting place and time).
2. **Offering seats.** An adult participant or guardian offers a car with N
   seats, a departure place and time; or "kan köra om det behövs" (willing
   to drive, no seats yet) so the leaders see who could. The return trip is
   created as a copy of the outward one and edited on its own (other place,
   time, or not driving home).
3. **Booking a seat.** A guardian books for their child; an adult for
   themselves. A child books for themselves from an age the guardian
   chooses; without a choice, the country pack's age, else 13. The guardian
   sees and can change the child's bookings. The return seat is booked in
   the same car and can be changed. Drivers and bookers get push
   notifications of bookings and changes.
4. **No adult alone with a child without the guardian's confirmation.** For
   every driver, leader or parent: when a car would carry one adult and a
   single child who is not the adult's own, the child's guardian must
   confirm the booking actively (with the driver's name) before it holds;
   until then it is pending. A child booking for themselves into such a car
   always needs the guardian's confirmation.
5. **Protected identity (ADR 0022).** A protected child can ride: the driver
   sees them (they must), the other passengers and everyone else do not;
   the guardian is told this before booking.
6. **Aggregation.** "Mina samåkningar" lists my drives and my children's
   seats across groups and clubs; the activity page shows the cars, free
   seats and, for leaders, who has no ride yet.
7. **Mileage.** Each drive records distance, passengers and driver. The
   distance is a field of the place in the club's list of places
   (`locations`: the distance from the club's starting point, kept with the
   place); the driver may correct it for a drive after the trip. No routing
   service and no home addresses (a self-hosted router may come later).
   Creating and editing places, their distance included, is one permission
   in the catalogue that **every leader in the club holds by default**
   (today `club.locations.create` lets leaders add places and edit only
   their own; it becomes create-and-edit for all places, and
   `club.locations.manage` keeps archiving and merging).
8. **Reimbursement.** A club may turn mileage reimbursement on and set a
   rate (the country pack gives the tax-free rate, e.g. per Swedish mil);
   more detail (per group, per vehicle, passenger supplements) may come
   later. A driver turns their drives into a claim; it is **attested**
   (below); approved claims are exported (CSV) for payment. Paying out
   comes in Phase 3.
   - **Settling among members instead of paying.** A club may prefer that
     members settle the driving among themselves (kvittning). A group
     setting makes its car-pool statistics **public in the group**: then
     its members see per person how far and how often they drove and rode,
     per period; otherwise the statistics are seen by the drivers
     themselves and by attesters and the group's leaders.
9. **A general attestation flow**, built for car-pool claims first and for
   other expenses later (receipts, purchases in Phase 3):
   - A claim (`expense_claims`: kind, amount, lines, the person, the
     activity or group it belongs to) goes first to **whoever created the
     activity**, if they may attest; otherwise to those who hold the
     permission.
   - Permissions in the catalogue (P1.15): attesting in a group
     (`group.expenses.attest`, group scope) and in the club
     (`club.expenses.attest`, club scope).
   - As is customary: nobody attests their own claim; every decision is
     audited (approve, reject with a reason); the claimant is told.
   - The flow is generic (kinds, routing, permissions), so new expense
     kinds plug in without a new flow.

10. **Kept until deleted.** Car pools, drives and the statistics are kept
    until someone deletes them explicitly (a driver their own offers before
    the trip; the club's attesters or administrators older data); no
    automatic deletion. Attested claims follow accounting rules. Erasing a
    person anonymises them in drives and statistics (the deletion ledger
    applies it again after a restore, ADR 0047).
11. **Events** use the same tables: an event session has a transport mode
    and car pools like an activity.
**Consequences.** Leaders see who can drive and who lacks a ride; members
settle or the club reimburses on the same numbers; clubs get attested
mileage claims ready for payment. Distances are as good as the club's list
of places; correcting a drive is the driver's.

## Amendment (2026-11-17, before P2.5)

Decided with the prompt's review:

- **Event sessions are activities** (`event_activities`): the transport
  mode and the car pools belong to activities (and series, inherited); an
  event's sessions have them because they are activities. There is no
  separate table for event sessions.
- **Plans**: car pooling and its statistics are in every plan;
  reimbursement, claims and attestation belong to the `finance` feature
  (`BILLING_ENABLED=false`: everything is available).
- **The mileage rate is a board setting** in the settings registry
  (ADR 0037, `decidedBy: "board"`): it is changed only by a recorded
  decision, which a governing document (a travel-expense policy) can mark
  (P2.4). Turning reimbursement on is part of the same setting (a rate of
  none: off). The club's starting place stays a manager setting.
- **One adult and a single child not their own** (decision 4) means: the
  car carries the driver, no other adult, and exactly one child, who is not
  the driver's own. "Own" is any active guardianship of the driver (parent,
  legal guardian, step-parent, foster parent). A second adult or the
  driver's own child in the car (the rule of two) makes confirmation
  unnecessary; a change that leaves the situation (another passenger
  cancels) asks again.
- **The self-booking age** is a guardian's setting per child, stored on the
  guardianship; with two guardians the higher age (the stricter) applies.

## As implemented (part A, car pools)

- Migration 0048: transport modes, `locations.distance_km`,
  `carpool_offers`, `carpool_bookings`, the guardianship's self-booking
  age, the group's public statistics, the club's starting place,
  `app.my_carpools` and `app.ward_booking_club`, the permission
  `club.carpools.manage` (club managers, treasurers) and the erasure step.
- The module `apps/api/src/modules/carpools`: the rule of two is a pure
  function settled after every change of a car's seats; a guardian booking
  may confirm at once (`confirmAlone`), having seen the driver's name; a
  child's own booking into such a car always waits.
- Offers are open to adults on the activity's roster (participants and
  leaders) and to guardians of a participant; one car per driver and
  direction. Seats: the passenger themselves, or a guardian with the right
  to sign up; the return seat is booked with the outward one when asked.
- Statistics are read through `group.activities.read`: leaders see every
  row, others their own and their children's unless the group made them
  public.
- The driver sets the seats free in the car (1–8, never below those
  booked) and may add a note to the car (migration 0049, at most 300
  characters, e.g. "room for a kit bag", "pets have been in the car"),
  shown with the car to those who see the car pool, never in a notice;
  passengers are told when it changes; erasure clears it.

## As implemented (part B, claims and attestation)

- Migration 0050: `clubs.mileage_rate` (minor units per km) as the board
  setting `mileage_rate`; `app.apply_board_decision` applies a decision and
  publishes a privacy policy version only when the decision holds a
  setting the policy shows (the old `app.apply_setting_decision` remains
  as a wrapper for a rolling deploy). A governing document marks it as
  `{{setting mileage_rate = 250}}` (empty: off).
- The country packs give the tax-free rate as a guide: SE 25 kr per mil,
  NO 3.50 kr per km (2026).
- `expense_claims` and `expense_claim_lines` (module
  `apps/api/src/modules/expenses`), behind the `finance` feature. A claim is
  for one group; its drives are the claimant's cars of started activities
  of that group, with a distance; a drive is in at most one claim that is
  not rejected. Routing to the activity's creator when the claim is for one
  activity and they may attest; otherwise the worker tells the group's
  attesters, then the club's.
- Attesting: `club.expenses.read` opens the queue (the club's attesters see
  every claim, a group's attester the group's); never one's own claim (also
  a database check); a rejection needs a reason. The CSV export
  (`club.expenses.attest`) marks approved claims exported.
- Attesters see the group's car-pool statistics too.
- A group's owners (of the group or a group above it) attest its claims
  too: owning a group gives `group.expenses.attest` (so an owner may still
  appoint a head coach, whose template role now attests).

## As implemented (part C, web, app and demo)

- Web: the transport mode on activity and series forms; the car pool on the
  activity page (cars there and home, bookings, booking for oneself or a
  child with the driver's name before confirming alone, offering and
  changing one's car, the leaders' list of those without a ride); "Mina
  samåkningar" (`/me/carpools`) with the guardian's confirmation; a group's
  statistics (`/groups/<id>/carpools`, where its leaders make them
  public); the starting place, a place's distance and deleting old car
  pools on the locations page; "Mina utlägg" (`/me/expenses`) and the
  attesters' queue with the CSV export (`/clubs/<id>/expenses`).
- From which age a child books seats themselves is set per child on the
  family page; `GET /api/v1/me/wards/{personId}/carpool-age` returns the
  caller's own setting and the country's default.
- App: the car pool on the activity screen (book, cancel, offer seats with
  a note and the return trip) and "Mina samåkningar" (confirm a child's
  seat). Cache first: the car pools of the coming week's activities that
  travel on their own are prefetched with the activities. Claims and
  attesting stay on the web.
- Request budgets for the car pool's reads; its writes cannot repeat and
  are covered by the module's tests.
- Demo (`docs/seed-data.md`): IK Norrbacka P2012's away match on Saturday
  with Anna's and Ahmed's cars, the board's mileage rate and Anna's two
  claims.

## A car pool without a transport mode (decided 2026-11-19, P2.7b)

A car pool is open on every activity of a group unless it has shared
transport (a bus) or is cancelled or has started: with no transport mode
set, the activity page offers **"Ordna samåkning"** to those who may offer
a ride (the roster and their guardians), and the first offer starts the car
pool (the mode itself stays unset; nothing is written on the activity). A
leader's explicit "shared transport" still hides it. Own transport shows the
car pool from the start, with who has no ride yet; without a mode that list
appears once there is a car.
