# 0014 — Backups: pgBackRest, immutable off-site copies

**Status:** Accepted

**Context.** Catastrophic failure or a breach (including ransomware) must not
lose club data. Attackers with production access must not be able to delete
backups.

**Decision.** pgBackRest with continuous WAL archiving (RPO ≤ 5 min), encrypted
client-side, stored at a different provider with object lock (WORM). Object
storage versioned and replicated to a second provider. Weekly automated
restore tests; twice-yearly DR drills. A deletion ledger is re-applied after
restores (GDPR). Details in `docs/operations/backup-restore.md`.

**Consequences.** Extra cost of a second provider. Restore is practised, not
theoretical.
