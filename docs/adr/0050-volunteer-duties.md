# 0050 — Volunteer duties (arbetspass)

**Status:** Accepted (decided 2026-11-12, before the Phase 2 duty prompt;
automatic distribution and qualifications in Phase 4, buying out in Phase 3)

**Context.** Clubs run on parents' and members' work: the kiosk at home
matches, the score table, cleaning days, officials at cups, lottery sales.
Teams usually give each player's family a share ("två kioskpass per spelare
och säsong") and keep track in spreadsheets. ADR 0047 and 0048 set the rules
for being alone with children and for background checks.

**Decision.**

1. **Duty types** are the club's catalogue (kiosk, score table, cleaning,
   cup official, referee, …): an instruction (documents attached, ADR 0049),
   a minimum age, and a background-check requirement where the duty means
   being alone with children (the country pack's flag and the club's
   stricter setting, ADR 0047). Required qualifications (e.g. kiosk training,
   a referee licence) are **prepared** in the model; the register of
   people's qualifications comes in Phase 4.
2. **Duty shifts** have a type, time, place, the number needed and a note;
   they belong to an activity or event (the kiosk during a home match,
   officials at a cup) or stand alone (a cleaning day), in a group or the
   club. They appear in "Mitt schema" and the calendar feeds.
3. **The quota is per player** (decision 1): a group sets shifts per player
   and season; a shift counts towards the player's quota whoever does it
   (a guardian, an older sibling, a grandparent), and adult members do their
   own. Young people take shifts from the duty type's minimum age.
4. **Distribution, Phase 2** (decision 2): **sign-up** (first come, open
   shifts shown to those who may take them) and **assignment** by the
   leaders. **Automatic fair distribution** (a proposed schedule spreading
   shifts by quota and stated unavailability, adjusted and published by the
   leaders) comes in **Phase 4**; the model keeps quotas and unavailability
   so it can be added without migration.
5. **Swaps are free** (decision 3): a person offers their shift or asks for a
   swap; whoever takes it over confirms; the leaders see the swap but do not
   approve it. A push reminder the day before; afterwards a shift is marked
   done or missed (a missed shift does not count).
6. **Visibility is a setting** (decision 4) of who sees whom on which shift
   and how others' quotas stand: the club chooses a default and whether its
   groups may change it, in both directions (more restrictive or more
   open); without that permission the groups follow the club. Leaders
   always see everything in their group.
7. **Aggregation:** "Mina pass" (mine and my children's shifts, what is left
   of the quotas, open shifts I may take) and the group's overview
   (unstaffed shifts, quotas per player for the leaders).
8. **Statistics:** hours and shifts per person, player, group and season,
   for quotas and for reporting voluntary work to grant givers (CSV).
9. **Buying out** (paying instead of working, decision 6) is prepared: a
   shift or a quota share can be marked bought out; payment comes in
   Phase 3.

**Permissions** (proposed; the prompt settles them): `group.duties.manage`
(create, assign and mark shifts in the group; leaders and team managers),
`club.duties.manage` (club-level shifts, every group; club managers),
`club.duty_types.manage` (the catalogue; club managers).

**Consequences.** Phase 2 replaces the spreadsheets with sign-up,
assignment, swaps and quotas; Phase 4 adds the automatic schedule and the
qualifications register on the same tables; Phase 3 adds paying to buy out.
