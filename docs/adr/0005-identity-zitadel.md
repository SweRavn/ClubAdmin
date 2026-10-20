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
