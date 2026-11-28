# Plugins

Plugins add country- and organisation-specific behaviour to ClubAdmin without
changing its core: reporting activity and members to grant schemes, and
checking background-check documents (ADR 0051, P2.7). They are packages
written against [`@clubadmin/plugin-api`](../packages/plugin-api), installed
by the operator and enabled per club.

## For clubs

A club manager enables a plugin on the club's page under **Tillägg**
(`/clubs/<club>/plugins`; a second factor is needed, `club.plugins.manage`)
and fills in its settings; the page shows the data each plugin gets and the
hosts it contacts before it is turned on. Only plugins for the
club's country are offered. Once a grant plugin is enabled:

- The attendance views show why a session does not count (for LOK: too short,
  too few participants aged 6–25, no leader, no sport on the group, …).
- Managers, registrars and treasurers see each period's report: which sessions
  and people count and why, the totals and the data to fix first (for
  example a missing birth date).
- On the club's page under **Bidrag** (`/clubs/<club>/grants`) each scheme
  lists its periods with the deadline (and the late steps once it has
  passed). A registrar or treasurer locks the period's report and downloads
  its files (CSV, PDF) to hand in. A locked report keeps its evaluation;
  attendance changed afterwards is flagged, not counted.
- Registrars and treasurers get a notification 14 and 3 days before a
  deadline while the period's report is not locked (the API's daily job
  `grants:deadline_reminders`).

Groups with adapted activities (parasport) are marked as such on the group
(`adapted`). Grant plugins count their members as "with a disability" where
the rules say so; ClubAdmin never stores health data about a person.

## Background checks

The background-check plugin of the club's country is **on by default**
(Sweden: registerutdrag, Norway: politiattest); a club that turns it off
under **Tillägg** has no background-check requirements at all.

- Who needs a check is set on the club's roles (the role page, one tap per
  category: regular contact with children, alone with children, overnight
  trips, board) and on duty types with contact with children. The template's
  coaches and team managers have regular contact with children.
- On **Trygghet → Registerutdrag** (`/clubs/<club>/safeguarding/background-checks`)
  registrars and safeguarding officers see who is missing a check, whose
  check expires within 60 days and which records may be deleted, and tick
  off a check that was shown to them (a second factor is needed). Nothing is
  uploaded: only the type, the issue date and how it was shown. Club
  managers also set stricter requirements (for example a new extract every
  36 months), request an attest where the club starts it (Norway) and delete
  records.
- Without a valid check where one is required, a leader cannot write to a
  child or join a chat with children, and cannot take a duty shift whose
  type has contact with children; the app says why.
- Everyone sees their own checks and what each club requires under
  **Mitt konto → Registerutdrag** (`/me/background-checks`). The person gets
  a reminder 60 and 14 days before a check runs out; the club's managers a
  weekly summary (counts only).

| Country | Check | Plugin | Rules |
|---|---|---|---|
| Sweden | Begränsat registerutdrag (arbete med barn), shown to the club | [`se.rf.registerutdrag`](../plugins/se-background-check/README.md) | Lag (2013:852); RF's statutes 5 § 8; at most six months old when shown |
| Norway | Politiattest, the club confirms the purpose | [`no.nif.politiattest`](../plugins/no-background-check/README.md) | Politiregisterloven §§ 37, 39; politiregisterforskriften § 34-1; Idrettsstyret 2017 (sak 185) |

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
The operator console lists the installed plugins (`/ops/plugins`, from `GET
/api/v1/ops/plugins`; operators with a second factor).

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

Start from one of the bundled plugins (`plugins/se-lok`, `plugins/no-lam`,
`plugins/se-background-check`, `plugins/no-background-check`).
A plugin is a TypeScript package under `plugins/` that exports
`definePlugin({ manifest, grantReporting?, backgroundChecks? })`, keeps its
texts in Swedish, English and Norwegian in the manifest, and passes the
conformance suite (`checkConformance` from `@clubadmin/plugin-api/testing`)
in its tests. Results name people and sessions by ID with reason codes; the
host turns those into texts and names. A background-check plugin's
`checkTypes` and `requirements` are static: the host reads them once per
process, not per club.
