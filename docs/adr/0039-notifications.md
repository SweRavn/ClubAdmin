# 0039 — Notifications: a recipient-owned inbox, rendered when read, delivered by the worker

**Status:** Accepted (P1.7).

**Context.** Until P1.7 the only messages were transactional emails sent
by the worker's `mail` handler (ADR 0032), one template per outbox event.
People need to hear about cancelled or moved trainings, call-ups, answer
reminders, late "not coming" answers, events and their places, join
decisions and family changes — in the app, as push notifications and by
email — and choose how. A guardian follows several children in several
clubs, so the inbox must be the person's, not a club's. Names must never
leak into push texts on a lock screen, and protected identity (ADR 0022)
must hold at the moment something is shown, not at the moment it was sent.

**Decision.**

- **A catalogue, not free text.** `packages/shared/src/notifications.ts`
  lists every notification type with its category (schedule, responses,
  leader, events, membership, club_admin, family, account; waitlist
  reserved for P1.10), whether its email is mandatory and whether it is
  immediate. Categories carry the defaults (email `always`, `no_app` or
  `never`; push on or off); `accounts.notification_settings` stores only
  what the person changed, so `{}` is valid and defaults can change.
- **Recipient-owned global tables** (ADR 0023): `notifications`,
  `notification_deliveries` and `push_devices` have row-level security
  enabled but not forced, with policies on `app.current_person_id()` and
  `app.is_system()`; `club_id` is a nullable column for display, retention
  and erasure. Only the worker writes (system context); people read their
  own inbox and update `read_at` only (column grant). Devices belong to the
  account; `app.claim_push_device` (security definer) moves a token to the
  caller's account when another account had it (the phone changed hands).
- **Rendered when read.** A notice stores its type, subject and `params`
  (IDs, enum values, counts, times and titles of activities or events; never
  people's names, notes or addresses) and `about_person_ids` (the wards or
  player it concerns). The API renders title and body in the reader's
  language from `notify.<type>` ICU messages and presents the people
  through the PersonPresenter, so a later protection change takes effect in
  the inbox. Push texts are rendered from the same messages and contain no
  names; with "lock-screen text" off they say only "New notification".
- **Fan-out in the outbox, idempotent.** The worker's `notifications`
  outbox handler resolves recipients with one statement per question (no
  N+1), inserts notices with `ON CONFLICT (recipient_person_id,
  dedupe_key) DO NOTHING` and their deliveries in the handler's
  transaction. A redelivered event or retried job creates nothing twice.
  Changes to activities and series are **debounced** with a Graphile job
  (`job_key`, `job_key_mode = replace`, 10 minutes; late "not coming" 5
  minutes) that re-reads the current state when it runs. Changes more than
  14 days ahead are not news yet; call-ups, new activities asking for
  answers and published events notify however far ahead.
- **Delivery.** One delivery row per channel (and push device). Push goes
  through a `PushProvider` (Expo Push over HTTPS, a `fake` provider for
  development and CI), in batches of 100, at most
  `NOTIFY_PUSH_PER_PERSON_HOUR` per person; receipts disable unregistered
  devices. Email goes into **one daily email at 17:00** in the recipient's
  time zone (not a setting), except immediate types and notices about
  something that starts or is due before the next daily email plus 24
  hours: those are sent at once. Every notice so reaches the person at
  least 24 hours ahead, or at once when the change comes later. Quiet hours
  (default 21:00–07:00) hold push, unless what it is about starts within
  two hours after they end. Deliveries whose notice was read or whose
  activity has started are skipped. Mandatory emails (managers changed,
  member exports, the email change) ignore the settings.
- **The existing account-bound emails** (join decisions, club creation,
  managers changed, exports, imports, family emails, the email change) are
  now notices of the new pipeline. Their email keeps the original text
  (`email.*` keys, rendered with the same `mailHandler` code) plus a footer
  with the unsubscribe link; the invitation emails to addresses without an
  account stay in `mail`. This amends ADR 0032's consequence that "moves the
  templates": they stay where they are.
- **Unsubscribe links** are `accountId.category.HMAC-SHA256(
  NOTIFICATION_TOKEN_KEY, "unsubscribe:<account>:<category>")`, never
  stored; rotating the key invalidates old links. Emails carry
  `List-Unsubscribe` with one-click (RFC 8058) to
  `POST /api/v1/notifications/unsubscribe`, and a web page asks before
  turning the category's email off. Push tokens are sealed with AES-256-GCM
  under a key derived from the same secret; their SHA-256 is the lookup.
- **Capabilities.** `/meta/client` lists `notifications.inbox`, and
  `notifications.push` only with `PUSH_PROVIDER` set; the app asks for
  permission and registers its token only then (ADR 0029).

**Consequences.**

- The inbox works without SMTP or push (self-hosting): the notices are
  always there; channels are added by configuration.
- Expo is a sub-processor for push (`docs/gdpr.md`); the payload holds a
  title and body without names, the notice ID and a path with IDs.
- Retention: notices 90 days, deliveries 30 days, devices 90 days after
  last use (`notifications:retention`); erasure deletes a person's notices
  and devices and removes them from `about_person_ids`.
- Merging duplicate people does not rewrite `about_person_ids` (duplicates
  with an account are never merged, so recipients are unaffected); an
  about list may name the removed duplicate until the notice expires, and
  the presenter leaves out people the reader may not see.
- Deferred: ending a session in the sessions list does not yet remove its
  push device (the app removes it on logout; Expo's "not registered"
  disables it); `GET /me` has no unread count (the bell reads
  `/me/notifications/unread-count`); the consistency test between leader
  recipients and the `activity.responses.read` policy is replaced by
  recipient-resolution tests in the worker.
