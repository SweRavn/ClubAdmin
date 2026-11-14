# 0024 — API tokens: JWT access token plus the bound ID token

**Status:** Accepted (P0.6)

**Context.** The API must know who is calling and how they logged in (MFA
for elevated roles, time of login for step-up, the identity-provider session
for revocation), and must create the account on the first login from the
verified email and name. Zitadel's JWT access tokens carry only issuer,
subject, audience, client and expiry: no `amr`, `auth_time`, `sid` or email.
Those are in the ID token issued together with the access token (also on
every refresh). Alternatives were token introspection (a network call per
request, no `amr` either), Zitadel Actions adding claims (a webhook from
Zitadel to the API on every token issuance, fragile) and the userinfo
endpoint (a network call, no `amr`).

**Decision.**
- Clients send the access token as `Authorization: Bearer` and the ID token
  issued with it in `X-Id-Token`. The API verifies both (issuer, audience =
  the Zitadel project, signature through a cached JWKS) and accepts the ID
  token only if its `at_hash` matches the access token and its subject is the
  same. It cannot be swapped for another login's ID token.
- From the ID token: `amr` (MFA), `auth_time` (`@RecentAuth`), `sid` (session
  revocation), verified email and names (provisioning, email sync). Without
  an ID token a request is authenticated but counts as "no MFA, unknown login
  time"; the first login (provisioning) needs it.
- DEV_AUTH tokens (development only) are HS256 JWTs from the web app that
  carry `amr`, `auth_time` and `sid` themselves.
- Token lifetimes are set by `pnpm auth:configure`: access and ID tokens 10
  minutes, refresh tokens 30 days idle / 90 days absolute, rotated on use.

**Consequences.** The BFF keeps the ID token server-side with the access
token and forwards both; the mobile app (P0.10) does the same. Validation
stays local (two signature checks, < 1 ms with a warm key cache). If Zitadel
later puts these claims into access tokens, the header becomes optional.
