# 0054 — Programmes and templates: a container for activities and shifts, copied without people

**Status:** Accepted (decided 2026-11-18; built in P2.9, 2026-11-28)

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

## As implemented (P2.9, 2026-11-28)

- Migration 0060: `programme_templates` (a group's or the club's),
  `programme_template_slots`, `programme_template_items` (day offsets and
  wall-clock times; activities' kind, label, place by reference or text,
  meeting minutes before, transport, home/away, opponent, answers; shifts'
  duty type, need and parent activity item), `programmes` and
  `programme_groups`; `activities.programme_id` and `tasks.programme_id`
  indexed on `(programme_id, starts_at)`. Tenant RLS, history and
  `updated_at` on every new table; `created_by_person_id` is the only person
  column (declared for merging).
- Permissions: `club.programmes.manage` (club managers); the derived
  `club.programmes.use` (it or planning any group's activities),
  `programme.read`/`programme.manage` and `programme_template.use`/`.manage`
  on two new resources. Laying out, saving and copying check every group
  involved in the controller as events do (`group.activities.manage`, plus
  `group.duties.manage` for shifts and `club.events.create` for an event).
- Templates come from a programme, an event (its sign-up settings with
  sign-up as days before the first day), a group's range of at most 31
  days, one activity with its shifts, or empty (the editor replaces the
  items as a whole, at most 300). A copy is a template made on the fly.
- Laying out is `preview` then `apply` with the same body; the apply runs
  the preview's rules and refuses with its first refusal's code. Bulk paths
  in the activities, duties and events services insert every activity,
  their groups, the read model, audit events (`audit.recordMany`) and
  outbox events (`outbox.publishMany`) in one statement each: about 40
  statements whatever the number of items, 300 items in well under a second
  locally (`programmes.integration.test.ts`). An event's sessions are
  created called up to nobody and the event as a draft.
- A local time the spring change skips becomes the same wall-clock time an
  hour later; an item never ends before it starts.
- An event gets its programme when its organisers open it
  (`POST /events/{eventId}/programme`, which adopts the event's sessions and
  their and its shifts). Activities carry `programmeId` ("Del av …").
- Deviation from the prompt's paths: a programme is read under its club
  (`/clubs/{clubId}/programmes/{programmeId}` and `…/timeline`), as the
  resource is loaded within the club; a group's programmes are
  `GET /groups/{groupId}/programmes` (group.activities.read) and the club's
  `GET /clubs/{clubId}/programmes` (club.activities.read); copying has its
  own preview (`…/copy/preview`). `GET /me/programmes?clubId=` reads one club
  as `/me/duties` does.
- The audit event `programme.applied` names what was laid out (activities,
  duty shifts, event) in its changed fields; the counts are in the response.
- Web: Program on the club's and the group's pages, the timeline per day
  (a column per place, conflicts marked, shifts filled of needed), laying
  out and copying with the preview, the template editor (items per day,
  teams and default groups, the sign-up, editions), "Spara som mall" on a
  programme, an activity and a group's range, and "Program" for an event's
  organisers. App: the timeline as a list per day from the activity screen,
  prefetched with the schedule's activities.

