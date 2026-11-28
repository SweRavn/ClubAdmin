# Politiattest (Norway) — `no.nif.politiattest`

A background-check plugin ([ADR 0051](../../docs/adr/0051-reporting-plugins.md),
decision 6) for the *politiattest* (barneomsorgsattest) in a Norwegian
sports club. Enabled by default for Norwegian clubs (P2.8); a club turns it
off under **Tillägg**, which lifts every requirement.

## Sources (consulted 2026-11-28)

- Politiregisterloven (LOV-2010-05-28-16) §§ 37 and 39: a politiattest for
  tasks involving responsibility for or trust relations with minors.
- Politiregisterforskriften § 34-1: the attest for voluntary organisations.
- Norges idrettsforbund: Idrettsstyret's decisions of 2008 and 2017 (sak
  185) and NIF's pages on politiattest: everyone from 15 with tasks
  involving trust or responsibility for minors or people with disabilities
  shows an attest; the club confirms the purpose (bekreftelse på formål)
  and its politiattestansvarlig sees the attest.

The police's and NIF's pages could not be fetched from the build
environment on the day; the facts above were checked against their
published summaries. Re-read them when the rules change.

## What the plugin does

- One check type, `attest`: the club starts it (initiator `club`) by
  confirming the purpose. `startRequest` records the confirmation in the
  plugin's state (reference `purpose-<person>-<date>`, status `requested`);
  there is no remote service to ask. The person applies to the police and
  shows the attest on paper or from the digital mailbox.
- From 15 years; no maximum age when shown and no periodic renewal (a new
  attest after a break of more than five months or in a new club, which the
  host sees as a missing record).
- Requirements: `regular_contact_with_children`, `alone_with_children` and
  `overnight` are required (NIF); `board` is recommended.

The club records only that an attest without remarks was seen and when;
never a copy and never a remark (an attest with remarks closes the case
without a reason).
