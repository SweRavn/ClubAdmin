# 0054 — Programmes and templates: a container for activities and shifts, copied without people

**Status:** Proposed (decided 2026-11-18; built in P2.9)

**Context.** Clubs run cups, camps, match days and cleaning days that are
many activities, meals and duty shifts over one or more days and places,
and they run the same ones again every season or year. Activities (ADR
0034), events with sign-up (ADR 0038) and duty shifts (ADR 0050, ADR 0052)
exist, but nothing groups them into one programme or copies them to new
dates; P1.6 left copying an event out of scope. Tournaments with generated
schedules are Phase 4 and need somewhere to put their matches.

**Decision.**

1. **A programme groups existing items.** `programmes` is a club-owned
   container; activities and duty-shift tasks get a nullable
   `programme_id`. Items keep all their behaviour (schedule, responses,
   notices, feeds, call-ups, car pools, duties). A programme may belong to
   one event; a programme without an event is any set of activities (a
   match day, a cleaning day).
2. **Meals and other programme items are activities** of kind `other` with
   a label and response mode `none` by default. No catering model.
3. **Templates belong to one club** (group or club scope) and are never
   shared across clubs. They hold no people and no personal data.
4. **Relative times in the club's time zone:** a day offset and a
   wall-clock time per item; laying out converts with the club's IANA
   time zone, so local times survive daylight saving time.
5. **Group slots** in a template are mapped to the club's groups when it is
   laid out; places are kept by reference, archived ones refused unless
   mapped, conflicts warned about, never blocking.
6. **Laying out is a preview, then one transaction** through the existing
   services (their rules, audit, history and notices), all or nothing.
   Copying to a new date is laying out a template made on the fly.
7. **Snapshots, no sync:** a template is a copy of its source; a programme
   laid out from a template records the template and an edition, and later
   changes on either side do not reach the other.
8. **Removing** a whole programme is allowed only while no item has
   responses, registrations, assignments, sign-ups or car-pool offers.

**Consequences.**

- One new permission (`club.programmes.manage`); group work uses the
  existing activity, duty and event permissions, checked per mapped group.
- Laying out up to 300 items needs bulk inserts and one schedule refresh
  per group to stay within the request budget rules (ADR 0040).
- Phase 4 tournaments generate their matches into a programme rather than
  inventing their own container.
- Public programme pages wait for Phase 3; sharing between clubs would need
  a separate decision on what crosses the tenant boundary.
