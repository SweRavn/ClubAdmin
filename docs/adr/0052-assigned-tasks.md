# 0052 — Assigned tasks: one system for duty shifts and action items

**Status:** Accepted (decided 2026-11-12; amends ADR 0049 decision 4 and
ADR 0050)

**Context.** Meetings produce action items with an assignee and a date
(ADR 0049); clubs give members duty shifts with a time and a quota
(ADR 0050). Both are "something a person has been given to do" and both
belong in one personal list. Two separate models would mean two lists, two
notification paths and two ways of marking things done.

**Decision.**

1. **One task model.** `tasks` (club, optional group, kind, title,
   description in Markdown, a due date or a time slot, the number of people
   needed, the source: a meeting's agenda item, an activity, an event
   session or none) and `task_assignments` (the person doing it, the person
   it counts for (a player's quota), how it was assigned: `assigned`,
   `signup` or `swap`, status `planned` | `done` | `missed`, who marked it
   and when).
2. **Kinds** add their own fields: `action_item` (from meeting minutes,
   P2.4) and `duty_shift` (duty type, place, quota, swaps, buying out
   prepared; P2.6). Further kinds (e.g. "ta med matchställen") plug in
   without a new list.
3. **"Mina uppgifter"** lists every task assigned to me and my children,
   across groups and clubs, with open shifts I may take; the same reminder
   and marking flow for every kind. Duty-shift quotas count only tasks
   marked done; nothing is marked done automatically.
4. **Order.** The meetings prompt (P2.4) builds
   the tables and "Mina uppgifter" for action items; the duties prompt
   (P2.6) adds shifts.

**Consequences.** One list for the person, one marking and reminder flow;
duty automation (Phase 4) and quotas work on the same rows. ADR 0050's
"Mina pass" is "Mina uppgifter".
