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
9. **Kept until deleted.** Car pools, drives and the statistics are kept
   until someone deletes them explicitly (a driver their own offers before
   the trip; the club's attesters or administrators older data); no
   automatic deletion. Attested claims follow accounting rules. Erasing a
   person anonymises them in drives and statistics (the deletion ledger
   applies it again after a restore, ADR 0047).
10. **Events** use the same tables: an event session has a transport mode
    and car pools like an activity.
11. **A general attestation flow**, built for car-pool claims first and for
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

**Consequences.** Leaders see who can drive and who lacks a ride; members
settle or the club reimburses on the same numbers; clubs get attested
mileage claims ready for payment. Distances are as good as the club's list
of places; correcting a drive is the driver's.
