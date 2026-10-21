# 0005 — Authentication via Zitadel (OIDC)

**Status:** Accepted

**Context.** Authentication is security-critical and includes passkeys, MFA,
social login, and later national eID (BankID, Freja). Building it ourselves is
risky.

**Decision.** Zitadel (AGPL-3.0, Go, PostgreSQL-backed) as OIDC provider,
sharing the Postgres cluster in a separate database. The app only speaks
standard OIDC, so Keycloak or another provider can replace it. Web uses a BFF
pattern (tokens server-side); mobile uses PKCE with secure storage. A
development-only `DEV_AUTH` provider supports persona login with seed data.

**Consequences.** One more service to run (included in compose). The app has no
password handling. eID comes via an OIDC broker configured in Zitadel.

**Amendment (P0.6).** Zitadel's configuration is code: `pnpm auth:configure`
applies `infra/zitadel/` (project, apps, policies, branding, texts)
idempotently. The apps use Zitadel's **built-in login UI (v1)**, because the
separate login UI v2 has no Swedish translation (its languages are fixed in
the build); v1 has complete Swedish texts and supports passkeys, TOTP,
security keys, self-registration with email verification and lockout. The
`loginVersion` setting in `infra/zitadel/clubadmin.json` switches back to v2
once it supports Swedish (and the `zitadel-login` container returns;
[#3](https://github.com/SweRavn/ClubAdmin/issues/3)).
Zitadel has no breached-password check; this is a known gap (password length
and lockout policies apply; [#1](https://github.com/SweRavn/ClubAdmin/issues/1)). The lockout policy is set on the
organisation, because Zitadel v4 cannot change it instance-wide over REST
([#2](https://github.com/SweRavn/ClubAdmin/issues/2)). How the API reads MFA and the login time from
Zitadel's tokens is ADR 0024.
