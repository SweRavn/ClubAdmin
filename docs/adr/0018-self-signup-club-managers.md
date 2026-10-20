# 0018 — Self sign-up, club creation and club managers

**Status:** Accepted

**Context.** People should be able to start without an invitation: create an
account, find and join a club, or create a new club and run it. Clubs need one
or more managers, and the manager role must be transferable.

**Decision.**

*Sign-up*
- Anyone can create an account (email verification required; passkey or
  password + optional MFA via Zitadel). The account creates a `person`.
- After sign-up the person can (a) accept a pending invitation, (b) search for a
  club and ask to join, or (c) create a new club.
- Anti-abuse: rate limits per IP and per email domain, CAPTCHA-free proof of
  work or a privacy-friendly challenge on suspicious traffic, email verification
  before any club action.

*Joining a club* — each club chooses a `join_policy`:
- `open`: membership becomes active immediately,
- `approval` (default): a join request that a manager or registrar approves,
- `invite_only`: club is not listed in search; joining only via invitation link
  or code.
A person can apply for themselves and for their children (guardian), giving
team preferences as a hint.

*Creating a club*
- Controlled by `CLUB_CREATION`: `open` (default when `DEPLOYMENT_MODE=hosted`),
  `approval` (operator approves), `operators_only` (default for self-hosted).
- The creator becomes the club's first **club manager** and an active member.
- With billing enabled, a new club starts on the configured default plan or
  trial.

*Club managers*
- `club_manager` is a club-level role assignment like the others
  (`domain-model.md`): full administrative rights in that club, MFA required.
- A club can have **any number of managers**.
- Managers can appoint and remove other managers. Every change is audited and
  notifies all managers.
- **Invariant: a club always has at least one active manager.** The last
  manager cannot leave, remove themselves or be removed without appointing a
  successor first. Enforced in the service and by a deferred database
  constraint trigger.
- **Transfer:** "hand over" = appoint the new manager and then step down, in one
  action; the new manager must accept before the old one is removed.
- **Recovery:** if all managers are gone (deceased, unreachable, accounts
  deleted), the board chair can claim the role, or an operator can reassign it
  on documented request from the club (e.g. board minutes), audited.

**Consequences.** Hosted service needs anti-spam and abandoned-club handling
(clubs without activity for 12 months get a warning and then are archived,
never silently deleted). Self-hosted deployments default to operators creating
clubs.
