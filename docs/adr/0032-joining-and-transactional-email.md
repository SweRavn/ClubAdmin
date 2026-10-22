# 0032 — Joining: join requests, invitation secrets, cross-club lookups and transactional email

**Status:** Accepted (P1.1). Refines ADR 0018.

**Context.** P1.1 implements sign-up to membership (ADR 0018). Four questions
came up that ADR 0018 leaves open: how an application is recorded (the P0.5
schema had both `applied` memberships and `join_requests`), how invitation
secrets reach the invited person when the email is sent by the worker, how a
person outside a club finds it (search, invitation links) when club tables
are forced under row-level security, and how email is sent before the
notifications package (P1.7).

**Decision.**

- **A join request is the only record of an application.** Clubs with
  `join_policy = approval` get a pending `join_requests` row; approving it
  creates the active membership in the same transaction; an accepted
  invitation settles a pending request. No code writes `applied`
  memberships any more: migration 0007 turned the open ones into pending
  requests. The status stays in the enum (ADR 0029: enums only grow).
- **Invitation secrets.** Only `sha256(secret)` is stored. Links carry 32
  random bytes and codes 8 characters from an alphabet without look-alikes;
  both are shown once to their creator. The token of an email invitation is
  `HMAC-SHA256(INVITATION_TOKEN_KEY, "club-invitation:" + id)`: the worker
  derives it from the invitation's ID when it sends the email, so no token
  is stored or put in an outbox payload. Rotating the key invalidates open
  email invitations. Lookups do not tell expired, revoked and used-up
  invitations apart.
- **Cross-club lookups.** `app.search_clubs` (listed clubs: active, not
  suspended, not `invite_only`; only listing fields) and
  `app.find_club_invitation` are SECURITY INVOKER functions that set the
  transaction setting `app.lookup` while their one query runs and clear it
  before returning. The `lookup_read` policies on `clubs` and `invitations`
  apply only while it is set. Like `app.club_id`, only trusted code sets it.
  Applicants read the clubs they asked to join through `applicant_read`.
- **Transactional email.** The API publishes domain events with IDs only
  (`invitation.created`, `join_request.decided`, `club.manager.changed`,
  `club_creation_request.decided`). The worker's `mail` outbox handler reads
  what the email needs, renders it from the ICU catalogues
  (`packages/i18n`, namespace `email`) in the recipient's language (account
  locale, then the club's), and sends it through a `MailProvider` (SMTP via
  nodemailer, MIT-0; `SMTP_URL`, `MAIL_FROM_ADDRESS`). Names of protected
  people appear only to recipients who may see them (ADR 0022): an
  invitation from a protected inviter does not name them. The Message-ID
  derives from the event's idempotency key, so a resent email is
  recognisable. Without `SMTP_URL` no email is sent.
- **Recovery is recorded.** An operator appointing a manager on the club's
  request stores the reason in `club_manager_reassignments`, readable by the
  club.

**Consequences.** P1.7 builds preferences, push and in-app notifications on
the same events and handler pattern, and moves the templates into its
notification catalogue. Email delivery failures retry through the outbox; a
send that succeeds just before a failed commit is sent again (with the same
Message-ID).
