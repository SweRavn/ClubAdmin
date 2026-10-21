# Security

ClubAdmin holds personal data about children, contact details, health notes,
background-check status and money. Security is a primary requirement, not a
later phase. Backup and disaster recovery are in
[`operations/backup-restore.md`](operations/backup-restore.md).

## Threat model (summary)

| Threat | Example | Main controls |
|---|---|---|
| Cross-tenant leak | Bug lets club B read club A's members | Authorization module + RLS + tenant-isolation tests on every endpoint |
| Privilege escalation inside a club | Player edits roles; parent sees other children's data | Deny-by-default policies, relationship-based permissions, policy tests |
| Fake sign-ups / spam clubs | Bots creating accounts and clubs | Email verification, rate limits, `CLUB_CREATION` policy, abandoned-club archiving |
| Account takeover | Phished admin password | IdP with passkeys, mandatory MFA for elevated roles, rate limiting, breach-password check, session revocation |
| Malicious insider (club) | Leader exports all members' data | Least privilege, field-level scoping, export audit + alerts, rate limits on bulk reads |
| Malicious/compromised operator | Platform staff browsing data | No default operator access, time-limited support grants approved by the club, all operator actions audited, separate DB role |
| Exposure of a person with protected identity | Name in a roster, chat, photo, calendar feed or history view reveals a protected member | Central `PersonVisibility` service on every person-bearing output, no attendee names in calendar data, explicit chat acceptance, access log on profile views (ADR 0022) |
| Calendar feed URL leaks | Shared or forwarded `.ics` link | Secret per-person tokens (hashed), revocable, no other people's names in feeds, answer links bound to one person and occurrence |
| Grooming / unsafe contact | Adult contacts a child privately | No adult–minor 1:1 chat without guardian, reporting, moderation, audit |
| Injection / XSS / CSRF | Stored XSS in a message | Parameterised queries (Drizzle), output encoding (React), strict CSP, sanitised rich text, SameSite cookies + CSRF tokens on BFF |
| Malicious upload | Malware in a document | Type allow list, size limits, ClamAV scan, serve from separate domain, `Content-Disposition: attachment` |
| Supply-chain attack | Compromised npm package | Lockfile, pinned versions, Renovate with delay, `pnpm` with lifecycle scripts disabled by default, OSV/Trivy scans, signed images, SBOM |
| Ransomware / destructive breach | Attacker deletes DB and backups | Immutable (object-lock) off-site backups with separate credentials, see backup doc |
| Denial of service | Login flooding, scraping | Rate limiting in Valkey, CDN, request size limits, timeouts |

## Controls

### Identity and sessions
- Zitadel (OIDC). Passkeys preferred; TOTP fallback. MFA mandatory for
  elevated roles (enforced by the API: `@RequireMfa`, from the `amr` claim of
  the ID token bound to the access token, ADR 0024).
- Login policy (`infra/zitadel/clubadmin.json`): email as login name,
  verified email before the first login, passkeys and TOTP/security keys,
  passwords of at least 10 characters with a lower-case letter and a digit,
  lockout after 10 failed password or code attempts (organisation level only,
  [#2](https://github.com/SweRavn/ClubAdmin/issues/2)), unknown login names not
  revealed, self-registration only when `USER_SIGNUP=open`. Zitadel has no
  breached-password check (known gap, ADR 0005, [#1](https://github.com/SweRavn/ClubAdmin/issues/1)).
- Access and ID tokens live 10 minutes; refresh tokens rotate on every use,
  expire after 30 days idle (90 days at most), and a rejected refresh (already
  used: possible theft) ends the session. Users see and revoke their sessions
  (`/api/v1/me/sessions`); revoking also ends the Zitadel session.
- Web: tokens never reach the browser (BFF): they are stored in Valkey,
  encrypted with `SESSION_ENCRYPTION_KEY`. Cookies `__Host-session`
  (`HttpOnly; Secure; SameSite=Lax; Path=/`) and `__Host-csrf`; every login
  creates a new session ID (no session fixation); CSRF double-submit token and
  same-origin check on every state-changing request; `returnTo` accepts only
  paths on the site (no open redirect); login flows are bound to the browser
  by a state cookie (no login CSRF). Logout removes the session, revokes the
  refresh token and ends the Zitadel session.
- Rate limits: `/auth/*` 30 requests per IP and minute (BFF, Valkey); first
  logins (account creation) 10 per IP and minute (API; in memory, so per API
  instance, [#7](https://github.com/SweRavn/ClubAdmin/issues/7)); the global API limit.
- Token contents are never logged (tests); rejected tokens are logged with the
  reason only.
- Step-up authentication for sensitive actions (exporting member data, viewing
  personal identity numbers, changing roles, payouts): `@RecentAuth(minutes)`.
- `DEV_AUTH` (log in as anyone) is refused unless `NODE_ENV=development` on a
  self-hosted deployment, in both API and web (tests).

### Authorization
- Deny by default; CI fails if an endpoint has no policy.
- Relationship-based policies (see `domain-model.md`), each with allow and
  deny tests.
- Postgres RLS as a second, independent barrier, enforced for the
  application's own database role: the API and worker connect as
  `clubadmin_app`, which cannot bypass RLS, run DDL, or change history and
  audit rows. Migrations run as `clubadmin_owner`; retention jobs as
  `clubadmin_retention`; operator tooling as `clubadmin_operator`, whose changes
  are rejected unless they identify the operator (see `architecture.md`,
  "Database").
- Database errors are rethrown without query parameters, and the logger
  redacts `detail`/`params` fields, so values never reach the logs.
- Field-level filtering: list endpoints return only fields the caller may see
  (e.g. coaches see guardians' phone numbers, not their addresses).

### Data protection
- TLS 1.3 everywhere (Caddy), HSTS preload, internal traffic on a private
  network; database connections use TLS.
- Encryption at rest: encrypted volumes; backups encrypted client-side before
  leaving the host.
- Field-level envelope encryption (AES-256-GCM, per-club data keys wrapped by a
  master key kept outside the database) for: personal identity numbers,
  medical/allergy notes, salary data, bank details. Implementation
  (`@clubadmin/server-kit/crypto`, P0.5): data keys in `crypto.data_keys`, one
  per club plus a global key for global tables; master keys from
  `ENCRYPTION_MASTER_KEYS` (`id:base64key`, current first; older keys only
  unwrap, so rotation means adding a key and rewrapping the data keys). Each
  ciphertext is bound to its table, column and row (AES-GCM associated data).
  Matching without decrypting uses blind indexes (HMAC-SHA256, per-purpose
  keys derived from `BLIND_INDEX_KEY`). Record history stores encrypted
  columns as `[changed]` only. Decrypting a personal identity number is
  audited (`person.personal_identity_number.viewed`).
- Background-check documents are **never stored**; only type, verified date,
  verifier, validity end.
- Personal data never written to logs, traces or error reports (redaction
  middleware + tests). Domain errors carry only a stable code; input
  validation errors and database constraint errors are never echoed (tests).

### Application hardening
- Strict Content Security Policy with nonces; no inline scripts; `frame-ancestors 'none'`
  except for explicit embeds.
- User content (rich text) sanitised server-side with an allow list.
- Uploads go directly to object storage via short-lived pre-signed URLs, are
  scanned before becoming visible, and are served from a separate origin.
- Request body limits, timeouts and rate limits per IP, per account and per club.
- Secrets via environment/secret store (SOPS + age for the hosted
  infrastructure); never in the repository; rotated on staff changes.

### Audit
- Append-only `audit_events` table: actor, on-behalf-of, club, action,
  resource, before/after field names (not values for sensitive fields), IP hash,
  request id, timestamp.
- Audit events are also streamed to separate storage the application cannot
  delete from.
- Club managers can view their club's audit log; operators can see operator
  actions only.
- **Record history** (ADR 0017): a database trigger on every table records
  each insert/update/delete with changed columns, old/new values, actor and
  request id in `history.record_changes`. Insert-only for the app role,
  RLS-scoped by club, values of restricted fields shown only to those allowed
  to see the field. This also captures changes made outside the application
  (operator SQL, migrations).

### Development process
- Branch protection, required review, CI: lint, typecheck, tests, licence check,
  dependency scanning (OSV-Scanner), container scanning (Trivy),
  static analysis (CodeQL), secret scanning.
- Security-relevant PRs (auth, policies, RLS, crypto, uploads) need an extra
  reviewer and a checklist.
- Yearly external penetration test once the hosted service has real users;
  public `SECURITY.md` with a disclosure process and `/.well-known/security.txt`.

## Incident response

1. Detect (alerts on anomalies: bulk exports, auth failures, RLS violations,
   unusual operator activity).
2. Contain: revoke sessions/keys, block accounts, put affected clubs in
   read-only mode if needed.
3. Assess what data and which clubs are affected (audit log).
4. Notify: as data processor, inform affected clubs (data controllers) without
   undue delay so they can notify the supervisory authority (IMY in Sweden)
   within 72 hours; prepared templates in `operations/`.
5. Recover (see backup doc), rotate all credentials, post-mortem published to
   affected clubs.
