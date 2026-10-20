# 0011 — S3-compatible object storage

**Status:** Accepted

**Context.** Documents, images, attachments and exports should not live in the
database.

**Decision.** Use the S3 API only. Hosted: the provider's object storage with
versioning, replicated to a second provider. Self-host: Garage (AGPL-3.0) in
compose; SeaweedFS as alternative. MinIO not used (community edition in
maintenance mode, no binaries). Uploads/downloads via short-lived pre-signed
URLs; files scanned with ClamAV before being made visible; per-club key prefix;
metadata and permissions in Postgres.

**Consequences.** Any S3-compatible service works for self-hosters.
