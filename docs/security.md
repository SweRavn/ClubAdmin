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
  elevated roles (enforced by the API: elevated permissions require the `amr`
  claim to contain an MFA method).
- Short-lived access tokens (≤ 10 min), rotating refresh tokens with reuse
  detection; user can see and revoke sessions/devices.
- Web: tokens never reach the browser (BFF). Cookies `HttpOnly; Secure;
  SameSite=Lax`; CSRF token on state-changing requests.
- Step-up authentication for sensitive actions (exporting member data, viewing
  personal identity numbers, changing roles, payouts).

### Authorization
- Deny by default; CI fails if an endpoint has no policy.
- Relationship-based policies (see `domain-model.md`), each with allow and
  deny tests.
- Postgres RLS as a second, independent barrier.
- Field-level filtering: list endpoints return only fields the caller may see
  (e.g. coaches see guardians' phone numbers, not their addresses).

### Data protection
- TLS 1.3 everywhere (Caddy), HSTS preload, internal traffic on a private
  network; database connections use TLS.
- Encryption at rest: encrypted volumes; backups encrypted client-side before
  leaving the host.
- Field-level envelope encryption (AES-256-GCM, per-club data keys wrapped by a
  master key kept outside the database) for: personal identity numbers,
  medical/allergy notes, salary data, bank details.
- Background-check documents are **never stored**; only type, verified date,
  verifier, validity end.
- Personal data never written to logs, traces or error reports (redaction
  middleware + tests).

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
