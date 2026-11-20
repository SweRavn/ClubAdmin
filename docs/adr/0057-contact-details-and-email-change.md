# 0057 — Registrars see and change contact details; changing one's login email

**Status:** Accepted (2026-11-20, P2.7d). Amends ADR 0041 and the P1.8a
decisions on shared fields.

**Context.** Since P1.8a a person's phone, address and gender reach a club
only if the person shared them (`club_profiles.shared_fields`), even for
the club's registrars ("Medlemsansvarig") and club managers. In the
maintainer's testing (2026-11-20) a registrar with a second factor saw no
address, phone or email for most members and could change none of them.
People have no email column (ADR 0020: the email is the account's login),
and nothing let a person change their own phone, address or email.

**Decision.**

1. **The club's registrars see contact details.** Holders of
   `club.people.details` or the new `club.people.contact.edit` in a
   member's club (in the built-in template: registrars and club managers)
   see the member's phone and address whether or not the person shared
   them. The club holds them to run the membership (legal basis: the
   membership agreement). Sharing keeps deciding what *other members and
   leaders* see. Protected members only with `club.people.protected`
   (`seesClubContact` in `authorization.policy.ts`).
2. **And the login email, read-only.** They see the member's login email
   (`email` on the profile, null without a login) and, for a child without
   one, the guardians' (the profile's guardian list, with phone and email;
   for registrars without the guardians' consent filter of P1.8a).
3. **They change phone and address.** A new permission,
   `club.people.contact.edit` (template roles `club_manager`, `registrar`;
   area "members", sensitive), with a second factor and never on behalf of
   someone: `PATCH /api/v1/people/:personId/club-contact?clubId=`. The
   audit event `person.contact.updated` names the fields, never the values;
   the record history keeps the change. They never change a login email:
   that would hand over the account.
4. **The person changes their own.** `PATCH /api/v1/people/:personId/contact`
   (`person.profile.update`: the person or a guardian acting on their
   behalf), on "Min profil" (`/me/profile`, the user menu) and on a ward's
   profile. A protected person stores no address (the existing check).
5. **Changing the login email needs the new address's code.**
   `POST /api/v1/me/email` (a login within 15 minutes, five requests per
   ten minutes) stores the address in `accounts.pending_email` with a new
   `pending_email_id` and an expiry (60 minutes). The worker emails a
   six-digit code to the new address; the code is an HMAC of
   `pending_email_id` with `INVITATION_TOKEN_KEY`, like the invitation
   links (ADR 0032), so it is stored nowhere. `POST /api/v1/me/email/confirm`
   checks it (five wrong codes drop the request); a right code sets the
   address in Zitadel as verified (user API v2 with the `clubadmin-api`
   machine user, `IAM_USER_MANAGER`), then in `accounts`, and publishes
   `account.email.changed`: the old address is told (the notice reads it
   from the account's history, P1.7). Until then the old address logs in
   and the page says the change is waiting; `DELETE /api/v1/me/email/pending`
   drops it. An ID token from a login before the change carries the old
   address; the API no longer takes a token's email over when the token's
   login is older than the account's last verification.

**Why not Zitadel's own email change with its code?** Zitadel can send the
code itself (`sendCode`), but then the code and its email are outside the
app: in development with `DEV_AUTH` there is no Zitadel user behind most
personas, the email would not be in the user's language or the app's
style, and the API would have to read Zitadel's state to show "waiting".
The API checking its own code and then setting the verified address in
Zitadel keeps one flow for both, with the same guarantees (only the owner
of the new address can finish it).

**Consequences.**
- `docs/domain-model.md` ("Field visibility", `accounts`) and
  `docs/roles-and-permissions.md` describe this.
- Migration 0055 adds the permission to the template and the clubs'
  roles, and the `pending_email*` columns.
- People without a login still have no email (out of scope).
