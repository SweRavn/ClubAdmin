# Registerutdrag (Sweden) — `se.rf.registerutdrag`

A background-check plugin ([ADR 0051](../../docs/adr/0051-reporting-plugins.md),
decision 6) for the *begränsat registerutdrag* a person shows before working
with children in a Swedish sports club. Enabled by default for Swedish clubs
(P2.8); a club turns it off under **Tillägg**, which lifts every requirement.

## Sources (consulted 2026-11-28)

- Lag (2013:852) om registerkontroll av personer som ska arbeta med barn:
  the right to ask for an extract for work with children outside school and
  child care (Polisen's form 442.14 or its e-service). The law gives the
  club a right to ask, not a duty.
- Riksidrottsförbundet, statutes chapter 5 § 8 (in force since 1 January
  2020) and RF's guide to checking extracts: every club checks the extract
  of everyone from 15 with direct and regular contact with children; the
  original is shown and handed back.
- Polisen's pages on the extract for work with children: an extract may be
  at most six months old when shown; a digital extract is shown from the
  person's digital mailbox; the club keeps no copy.

Polisen's and RF's pages could not be fetched from the build environment on
the day; the facts above were checked against their published summaries.
Re-read them when the rules change.

## What the plugin does

- One check type, `extract`: the person orders it (initiator `person`),
  from 15 years, shown on paper (`viewed`) or from the digital mailbox
  (`digital_mailbox`); no integration, no cost to the club, no copy.
- `verifyPresented` refuses an extract issued more than six calendar months
  before it is shown (`lastDayToShow`) or issued in the future.
- RF sets no re-check interval (`recheckMonths: null`): a club that wants
  one sets it as a stricter requirement (for example every 36 months).
- Requirements: `regular_contact_with_children`, `alone_with_children` and
  `overnight` are required (RF's statutes); `board` is recommended.

Nothing about the extract's contents reaches ClubAdmin: the verifier ticks
off that an extract without entries was seen and enters its issue date. An
extract with entries closes the case without a reason.
