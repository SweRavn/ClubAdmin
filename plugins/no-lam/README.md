# Samordnet rapportering, the basis of LAM (Norway) — `no.nif.samordnet`

A grant-reporting plugin ([ADR 0051](../../docs/adr/0051-reporting-plugins.md))
for the figures a club reports in samordnet rapportering. Lokale
aktivitetsmidler (LAM) are not applied for by the club: each municipality's
idrettsråd distributes them to clubs with activity for children (6–12) and
youth (13–19), using the clubs' member or activity figures on 31 December.

## Sources

- NIF, Lokale aktivitetsmidler (LAM):
  <https://www.idrettsforbundet.no/klubbguiden/drifte-et-idrettslag/okonomi/stotteordninger/lokale-aktivitetsmidler-lam/>
- NIF to idrettsråd, *Tildeling av Lokale aktivitetsmidler for 2026*:
  [lam-2026-brev-fra-nif-til-idrettsrad-og-idrettskretser-for-2026.pdf](https://www.idrettsforbundet.no/contentassets/57eff2efb62542859be58348aa276fac/lam-2026-brev-fra-nif-til-idrettsrad-og-idrettskretser-for-2026.pdf)
- NIF, *Informasjon om Lokale Aktivitetsmidler for 2026* (members counted from
  paid memberships):
  [lam-informasjon-om-lam-2026-til-idrettsrad-og-idrettskretser.pdf](https://www.idrettsforbundet.no/contentassets/57eff2efb62542859be58348aa276fac/lam-informasjon-om-lam-2026-til-idrettsrad-og-idrettskretser.pdf)
- KUD to NIF, *Tilskudd til lokale lag og foreninger (LAM) 2026*:
  [lam-2026-tilskudd-til-lokale-lag-og-foreninger-lam-fra-kud-til-nif-for-2026.pdf](https://www.idrettsforbundet.no/contentassets/76a5289d74e448eca0be2043dfd56e66/lam-2026-tilskudd-til-lokale-lag-og-foreninger-lam-fra-kud-til-nif-for-2026.pdf)
- NIF, *Nøkkeltallsrapport 2024* (who counts as an active member, the age
  bands):
  [nokkeltallsrapport-2024---norges-idrettsforbund.pdf](https://www.idrettsforbundet.no/contentassets/9f94ba79767846d9a67d1a56f4054dc2/nokkeltallsrapport-2024---norges-idrettsforbund.pdf)

## What the plugin does

- **Members** on 31 December: paying members (unpaid fees are left out;
  clubs that do not keep fees in ClubAdmin get a note to check), by sex and
  the age reached in the year: 0–5, 6–12, 13–19, 20–25, 26+; the LAM target
  groups 6–12 and 13–19.
- **Active members** per sport: members who take part regularly in a group
  or hold a role there, counted once per sport (a member in two sports
  counts in both); passive (supporting, honorary, family) members only as
  members.
- **Members with a disability** per sport: active members of adapted groups
  (a group flag, never health data about a person).
- **All-round sport** (allidrett): members of groups whose sport is the
  club's setting `allidrettSport`.
- Due 30 April in KlubbAdmin; the files (CSV, PDF) are the figures to enter.
