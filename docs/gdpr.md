# GDPR and privacy

## Roles

- **The club is the data controller** for its members' data.
- **The hosted-service operator is the data processor** (personuppgiftsbiträde).
  Every club accepts a data processing agreement (DPA) when it signs up; the list
  of sub-processors is public and clubs are notified of changes.
- **Self-hosting organisations** are controller (and their own processor).
- The person's global account data (login, preferences) is controlled by the
  operator; this is described in the platform privacy notice.

## Principles in the product

| Principle | How |
|---|---|
| Data minimisation | Only `given_name`, `family_name`, `birth_date` and one contact method required. Personal identity number only when the country pack needs it (e.g. LOK-stöd) and only visible with elevated rights. |
| Purpose limitation | Consents are per purpose (photo publication, streaming, sharing with federation, marketing). |
| Storage limitation | Retention rules per data category, configurable per club within legal limits, enforced by a nightly job. |
| Integrity & confidentiality | See `security.md`. |
| Accountability | Audit log, record of processing activities (ROPA) template generated per club. |

## Legal bases (typical, club can adjust)

| Processing | Basis |
|---|---|
| Membership register, activities, attendance | Contract (membership) / legitimate interest |
| LOK-stöd and grant reporting | Legal obligation / legitimate interest (grant rules) |
| Background-check status | Legal obligation / legitimate interest; Art. 10 data → only metadata stored |
| Photos/video publication, streaming | Consent (guardian consent for children below consent age) |
| Newsletters to non-members | Consent |
| Salary | Contract + legal obligation |

## Data subject rights (self-service)

- **Access / portability:** "Download my data" (all clubs, JSON + human-readable
  PDF/HTML), produced by the worker within minutes.
- **Rectification:** person edits own profile; club managers edit club-specific data.
- **Erasure:** person can leave a club; leaving schedules deletion of club-specific
  data after the club's retention period (records required by law, e.g. accounting
  or grant reports, are kept in minimised form). Full account deletion anonymises
  the person everywhere: `people` row anonymised, messages kept as
  "deleted user" if the room requires history, otherwise deleted. The person's
  values are also scrubbed from the record history (the fact that a change
  happened is kept). The database function `privacy.erase_person` does this
  for the data that exists so far (people row: names emptied, birth date kept
  as the year, identity number, phone and address removed; login email
  replaced; club notes and emergency contacts; invitations; record history)
  and records the person in the deletion ledger; it is idempotent, so it is
  run again for every ledger entry after a restore (ADR 0030). The erasure
  job and its triggers (account deletion, retention) come in P1.8.
- **Objection / consent withdrawal:** one click per consent; effects apply
  immediately (e.g. hidden from photo galleries and streams).
- Guardians exercise rights for children below the consent age; teenagers get
  increasing control as they approach adulthood (country pack rules).

## Retention defaults (Sweden, configurable)

| Data | Default |
|---|---|
| Former member's profile | 2 years after leaving (allows re-joining, annual reports) |
| Attendance/LOK records | As required by grant rules (currently several years; set in country pack) |
| Accounting records | 7 years (Bokföringslagen) |
| Chat messages | Until room deleted, or club rule (e.g. 2 years) |
| Background-check verification metadata | While role is held + 1 year |
| Audit log | 2 years (security) |
| Record history | 2 years (configurable); personal values scrubbed on erasure |
| Join requests (decided) and invitations that can no longer be used, with their acceptances | 12 months after the last change (worker `joining:retention`, P1.1); pending requests and usable invitations stay |
| Member register export files (P1.2) | 24 hours (worker `members:expire_exports`; the bucket's lifecycle rule deletes `exports/` after two days as a backstop); only the requester can download them, through a pre-signed link valid five minutes |
| Member register export records (who, when, which columns and filter, row count; no values) | Kept as part of the audit trail, like the audit log |
| Member import files (P1.3b) | Deleted as soon as they are read (the bucket's lifecycle rule deletes `imports/` after two days as a backstop) |
| Member import staging rows (the file's values, personal identity numbers sealed) | Seven days after the import ends or is cancelled; an import left in review for seven days is cancelled (worker `members:purge_imports`). The import record (who, when, counts) is kept like the audit log |
| Emails from an import file | Never stored on people (ADR 0020): only in the invitations sent (guardian and own-login invitations, deleted with them) |
| Guardian and own-login invitations that were never accepted (P1.3) | 12 months after they expired or were revoked (worker `joining:retention`); accepted ones stay as the record of the guardianship or login |
| Merges (`people_merges`) | The record and what was moved stay for the 30-day undo period, then as the record of the merge (audit trail) |
| Invitation email addresses | With the invitation (above); never logged, never in outbox or job payloads |
| Backups | ≤ 12 months, then destroyed (deletion ledger re-applied on restore; the ledger export next to the backups holds erased person IDs only) |

## Protected identity

People with protected personal data are hidden from other members, excluded
from public pages, photos and streams, have no stored postal address, and every
view of their profile is logged. See `domain-model.md` and ADR 0022.

## Children

- Default privacy settings for minors are the strictest: no public profile,
  no name in public pages or streams without guardian consent.
- Safe communication rules (see `domain-model.md`).
- Streaming and photos of children require explicit consent per child; the
  stream UI shows which participants lack consent.

## Hosting location

Hosted service: all personal data processed and stored in the EU/EEA, using
EU-headquartered providers where feasible. No analytics trackers; first-party,
cookie-less, aggregated metrics only. No third-party ad networks.
