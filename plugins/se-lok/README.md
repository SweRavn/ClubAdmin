# LOK-stöd (Sweden) — `se.rf.lok`

A grant-reporting plugin ([ADR 0051](../../docs/adr/0051-reporting-plugins.md))
for statligt lokalt aktivitetsstöd. It evaluates a club's group activities
under RF's rules and gives the registrar a report to check and register.

## Sources

- RF, *Föreskrifter om statligt lokalt aktivitetsstöd*, fastställda av RS
  2025-05-22, in force from 2025-07-01:
  [LOK-stödsföreskrifter 20250522 (PDF)](https://www.rf.se/download/18.541eee07197627cf1f795bb9/1750073010580/LOK-st%C3%B6dsf%C3%B6reskrifter%2020250522.pdf)
- RF, LOK-stöd: <https://www.rf.se/bidrag-och-stod/lok-stod>

## What the plugin does

- **§ 5** a group activity: a leader appointed by the club who turns 13 in
  the year, at least 3 participants active at the same time for at least 45
  minutes (a municipal variant may ask for more: the setting `minMinutes`),
  at most 20 participants per leader present, a leader never leading two
  group activities at once.
- **§ 6** participant support: participants who turn 6–25 in the calendar
  year (no upper age with a disability: members of an adapted group),
  leaders who turn 13–25, members of the club only; one group activity per
  person, SF sport and day; at most 3 (6–9) or 5 (10–25) per SF sport and
  calendar week (Monday–Sunday); the occasions weighted 3Z, 3Z, 2Z (6–9)
  and 3Z, 3Z, 2Z, Z, Z (10–25). RS sets X, Y and Z each year, so the report
  counts units, not kronor; two or more leaders give the extra leader
  support.
- **§ 7, § 8** periods: 1 January–30 June (due 25 August) and 1 July–31
  December (due 25 February); 25, 50 or 75 per cent less when late, refused
  from 1 October respectively 1 April.
- The rules are versioned by the activity's date (`src/rules.ts`);
  activities before 1 July 2025 are outside them.
- Files: CSV and PDF for checking and registering in idrottens
  verksamhetsredovisningssystem (they list names and birth dates, never
  personal identity numbers). Submitting through RF's integration needs an
  agreement ([#22](https://github.com/SweRavn/ClubAdmin/issues/22)).

Not modelled: the recruitment exception for non-members (§ 6), the cap for
clubs connected to RF for less than two years (§ 3, from 2026-01-01), and
whether a leader from another club is an RF member.
