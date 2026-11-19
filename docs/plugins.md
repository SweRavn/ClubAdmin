# Plugins

Plugins add country- and organisation-specific behaviour to ClubAdmin without
changing its core: reporting activity and members to grant schemes, and
checking background-check documents (ADR 0051, P2.7). They are packages
written against [`@clubadmin/plugin-api`](../packages/plugin-api), installed
by the operator and enabled per club.

## For clubs

A club manager enables a plugin under the club's settings (a second factor is
needed, `club.plugins.manage`) and fills in its settings. Only plugins for the
club's country are offered. Once a grant plugin is enabled:

- The attendance views show why a session does not count (for LOK: too short,
  too few participants aged 6–25, no leader, no sport on the group, …).
- Managers, registrars and treasurers see each period's report: which sessions
  and people count and why, the totals and the data to fix first (for
  example a missing birth date).
- A registrar or treasurer locks the period's report and exports its files
  (CSV, PDF) to hand in. A locked report keeps its evaluation; attendance
  changed afterwards is flagged, not counted.

Groups with adapted activities (parasport) are marked as such on the group
(`adapted`). Grant plugins count their members as "with a disability" where
the rules say so; ClubAdmin never stores health data about a person.

## Grant schemes and their rules

The bundled plugins implement these rules. When an organisation publishes new
rules, the plugin gets a new rule version (the old one stays for earlier
periods); the README of each plugin says how it reads the rules.

| Country | Scheme | Plugin | Rules (source documents) |
|---|---|---|---|
| Sweden | LOK-stöd (statligt lokalt aktivitetsstöd), Riksidrottsförbundet | [`se.rf.lok`](../plugins/se-lok/README.md) | [LOK-stödsföreskrifter, fastställda 2025-05-22 (PDF)](https://www.rf.se/download/18.541eee07197627cf1f795bb9/1750073010580/LOK-st%C3%B6dsf%C3%B6reskrifter%2020250522.pdf), in force from 2025-07-01; [RF's page on LOK-stöd](https://www.rf.se/bidrag-och-stod/lok-stod) |
| Norway | Samordnet rapportering, the basis for LAM (lokale aktivitetsmidler), Norges idrettsforbund | [`no.nif.samordnet`](../plugins/no-lam/README.md) | [LAM 2026: letter from NIF to idrettsråd and idrettskretser (PDF)](https://www.idrettsforbundet.no/contentassets/57eff2efb62542859be58348aa276fac/lam-2026-brev-fra-nif-til-idrettsrad-og-idrettskretser-for-2026.pdf); [Information on LAM 2026 (PDF)](https://www.idrettsforbundet.no/contentassets/57eff2efb62542859be58348aa276fac/lam-informasjon-om-lam-2026-til-idrettsrad-og-idrettskretser.pdf); [LAM 2026 from KUD to NIF (PDF)](https://www.idrettsforbundet.no/contentassets/76a5289d74e448eca0be2043dfd56e66/lam-2026-tilskudd-til-lokale-lag-og-foreninger-lam-fra-kud-til-nif-for-2026.pdf); [NIF key figures 2024 (PDF)](https://www.idrettsforbundet.no/contentassets/9f94ba79767846d9a67d1a56f4054dc2/nokkeltallsrapport-2024---norges-idrettsforbund.pdf); [NIF's page on LAM](https://www.idrettsforbundet.no/klubbguiden/drifte-et-idrettslag/okonomi/stotteordninger/lokale-aktivitetsmidler-lam/) |

The sources were read on 2026-11-19 (ADR 0051, "Sources"). Municipal grants
that build on LOK (for example a longer minimum session) are settings of the
LOK plugin; other municipal schemes need plugins of their own.

## For operators

The API bundles the plugins in `apps/api/src/plugins.ts`; the `PLUGINS`
setting chooses which are installed (all bundled ones by default). A plugin
whose contract version the API does not support stops the start.
`GET /api/v1/ops/plugins` lists the installed plugins (operators, second
factor).

## What a plugin may see

A plugin declares the data it needs (`data` in its manifest, from a closed
list) and the hosts it calls (`network`); the host passes only the declared
fields, a restricted HTTPS client and a logger that drops personal data.
Calls run with a timeout outside any database transaction; a failure is
contained and audited (`plugin.call_failed`). Reports store IDs and reason
codes, never names; the people's data is read again for an export and used
only during the call. Personal identity numbers are passed only to plugins
that declare them and only while evaluating, never stored in a report or
logged.

## Writing a plugin

Start from one of the bundled plugins (`plugins/se-lok`, `plugins/no-lam`).
A plugin is a TypeScript package under `plugins/` that exports
`definePlugin({ manifest, grantReporting?, backgroundChecks? })`, keeps its
texts in Swedish, English and Norwegian in the manifest, and passes the
conformance suite (`checkConformance` from `@clubadmin/plugin-api/testing`)
in its tests. Results name people and sessions by ID with reason codes; the
host turns those into texts and names.
