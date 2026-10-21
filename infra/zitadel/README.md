# Zitadel configuration as code

`pnpm auth:configure` (run by `pnpm dev:services`) applies this directory to
Zitadel through its API, idempotently. Implementation:
`packages/devtools/src/zitadel.ts`.

| File | Contents |
|---|---|
| `clubadmin.json` | Project `clubadmin`; OIDC apps `web` (confidential, code + PKCE), `mobile` (native, PKCE) and the `api` app; the `clubadmin-api` machine user (ends Zitadel sessions when a session is revoked); login, password, lockout and domain policies; token lifetimes; branding; languages; which login UI the apps use. `${PUBLIC_WEB_URL}` and other `${VAR}`s come from the environment. |
| `login-texts/<lang>.json` | Overrides of the login UI's default texts (ClubAdmin wording) per language. |

**Development:** the token of the `clubadmin-config` machine user is read from
Zitadel's bootstrap volume; results (client IDs, the web client's secret, the
API's machine-user token) are written to `.env.local`.

**Operators:** run against your Zitadel with an IAM-owner token and print the
results instead of writing a file:

```
ZITADEL_URL=https://auth.example.org ZITADEL_PAT=... PUBLIC_WEB_URL=https://club.example.org \
  pnpm auth:configure --print
```

Set the printed `AUTH_*` values and `ZITADEL_API_TOKEN` in the API's and web
app's environment. Rerunning keeps existing client secrets and tokens when
they are passed in (`AUTH_WEB_CLIENT_SECRET`, `ZITADEL_API_TOKEN`); otherwise
new ones are generated.

Login UI: Zitadel's built-in login (v1), because login UI v2 has no Swedish
translation yet (ADR 0005, [#3](https://github.com/SweRavn/ClubAdmin/issues/3)).
