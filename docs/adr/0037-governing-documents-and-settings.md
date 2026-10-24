# 0037 — Governing documents: club settings taken from adopted documents

**Status:** Accepted (design; the documents module comes in Phase 2, the
settings registry it relies on in P1.8).

**Context.** Clubs decide many of the values ClubAdmin needs at their
annual meeting or in the board: how long former members' data is kept, how
long attendance is kept, consent purposes, and more as modules are added.
Those decisions live in the statutes, in the minutes of annual and board
meetings, or in policies. Phase 2 brings documents and board meetings
(statutes, minutes, versions) into ClubAdmin. When the same value is both
decided in a document and set in ClubAdmin, the two drift apart, and nobody
can tell which decision a setting rests on.

**Decision.**

- **Opt-in per club.** A club chooses whether it manages governing
  documents in ClubAdmin (`clubs.governing_documents_enabled`, default
  off). Without it nothing changes: every setting is set by hand as today.
- **One registry of club settings.** Every club setting that a document
  could decide has a stable key, a type, limits (system and country pack)
  and its column, in one registry in `packages/shared` (P1.8 starts it as
  the retention registry and widens it to all club settings). The keys
  are part of the documents' format, so they are never renamed (ADR 0029
  applies to them as to the API).
- **A source per setting.** With governing documents on, each registered
  setting has a source: `manual` (set in ClubAdmin, as today) or
  `document` with a **document series**: the statutes, the annual
  meeting's minutes, the board's minutes, or another series the club
  keeps (a policy). The value is taken from **the latest adopted document
  in that series that contains the setting**; a later document in the
  series that does not mention it leaves the value as it was. The choice
  of series only offers series in which at least one adopted document
  contains the setting. Changing the source is a club-manager action with
  MFA, audited.
- **Settings in the text.** A document marks a decided value in its text,
  e.g. "Uppgifter om tidigare medlemmar sparas i
  `{{former_member_retention_months: 24}}` månader." ClubAdmin shows the
  sentence with the value ("… sparas i 24 månader …") and knows the key
  and the value. The editor offers the registry's keys, checks types and
  limits while drafting, and shows the current value and its source.
- **One direction.** Documents decide settings; settings never write into
  documents. A setting taken from a document is read-only in the settings
  pages ("Set by § 7 in the statutes adopted on 15 March 2026", linked);
  changing it means adopting a new document (or switching the source back
  to `manual`).
- **Adoption and effect.** A document takes effect when it is recorded as
  adopted (date, the meeting or minutes it was adopted at), from its
  effective date if it states one. Then, in one transaction per club, the
  settings whose source points at its series and that it contains get the
  new values (a scheduled job applies future effective dates). Each change
  is audited as `club.settings.updated` with the document version as the
  reason, so history shows which decision a value rests on. ClubAdmin
  records adoption; it does not judge whether the meeting followed the
  statutes' own rules (majorities, two meetings).
- **Invalid values.** Limits are checked while drafting. If an adopted
  document still holds a value outside the system's or the country pack's
  limits (a minute records what was decided), the setting keeps its
  previous value, and club managers see a warning naming the document and
  the limit until a new document or a manual source resolves it.
- **Templates.** A country pack may offer a statutes template with the
  settings already marked (for `se` based on Riksidrottsförbundets
  normalstadgar, if RF's terms allow redistributing the text; to be
  checked before shipping).

**Consequences.**

- Phase 1 settings are written through one service path per setting
  (`ClubsService.updateSettings` and the registry), so Phase 2 adds the
  source check in one place; no source column exists before Phase 2.
- The documents module (Phase 2) owns documents, series, versions,
  adoption and the editor; the settings registry stays in
  `packages/shared`; the clubs module applies values.
- Settings that are not club settings (installation settings such as
  `AUDIT_RETENTION_MONTHS` or `CLUB_ARCHIVE_RETENTION_MONTHS`) cannot be
  taken from documents.
- A club that turns governing documents off keeps the current values,
  with every source back to `manual`.
