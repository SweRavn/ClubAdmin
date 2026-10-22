# 0011 — S3-compatible object storage

**Status:** Accepted

**Context.** Documents, images, attachments and exports should not live in the
database.

**Decision.** Use the S3 API only, as a protocol: ClubAdmin depends on no
particular provider and on no AWS service, SDK or account (the request
signing is the S3 protocol's Signature Version 4, which every S3-compatible
service uses). Hosted: object storage at a European provider (for example
Scaleway, OVH, Hetzner or UpCloud) with versioning, replicated to a second,
independent European provider (docs/hosting-and-billing.md, data in the
EU/EEA). Configuration names the provider's endpoint and region explicitly:
there is no default region. Self-host: Garage (AGPL-3.0) in
compose; SeaweedFS as alternative. MinIO not used (community edition in
maintenance mode, no binaries). Uploads/downloads via short-lived pre-signed
URLs; files scanned with ClamAV before being made visible; per-club key prefix;
metadata and permissions in Postgres.

**Consequences.** Any S3-compatible service works for self-hosters.

**Update (P1.2, member register exports).** The application talks to object
storage through a small client in `@clubadmin/server-kit/object-storage`
(Signature Version 4 on `fetch`: multipart upload, delete, lifecycle rule,
pre-signed GET), not an S3 SDK: the calls are few, the SDK is large and
updates often, and the same signing code already served the dev smoke test
and the backup checks. Path-style URLs work with Garage, SeaweedFS and the
hosted providers. Configuration: `S3_ENDPOINT` (the API and worker reach it),
`S3_PUBLIC_ENDPOINT` (browsers download from it; pre-signed links are signed
for that host), `S3_REGION`, `S3_BUCKET_FILES`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`; without them exports answer `export_storage_unavailable`.
Exports live under `exports/<club_id>/` in the files bucket; the worker adds a
lifecycle rule for that prefix (two days) when the bucket has none, and leaves
a bucket with other rules alone (an operator adds the rule, docs/gdpr.md).
