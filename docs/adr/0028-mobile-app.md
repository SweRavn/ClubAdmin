# 0028 — Mobile app: login, development tokens, encrypted cache, updates and per-account rate limits

**Status:** Accepted (P0.10).

**Context.** P0.10 builds the Expo app for iOS and Android (ADR 0008). Unlike
the web app, it has no backend-for-frontend: it holds its own tokens, calls
the API directly from many devices behind shared addresses, keeps data on the
phone for offline use, and stays installed in old versions. Several things
had to be decided:

- how the app logs in and keeps the login (Zitadel's native `mobile` client
  exists since P0.6), and how development builds log in as demo personas
  without the DEV_AUTH signing key;
- how a person sees and ends the app's sessions. Checked against the real
  Zitadel (`apps/web/e2e/mobile-zitadel.spec.ts`): ending the Zitadel session
  (`DELETE /v2/sessions/{id}`, as for browser sessions) does **not**
  invalidate the app's refresh token;
- where cached data lives, given that it contains names of protected people
  for privileged viewers;
- how development builds reach the local services over HTTPS (Caddy's local
  CA) without weakening release builds;
- what the per-IP API rate limit means for many members behind one carrier
  NAT ([#11](https://github.com/SweRavn/ClubAdmin/issues/11)), and the
  per-instance provisioning limit
  ([#7](https://github.com/SweRavn/ClubAdmin/issues/7)).

**Decision.**

- **Stack:** Expo SDK 57 (React Native 0.86, React 19.2, Hermes), Expo
  Router (`apps/mobile/src/app`), TanStack Query, use-intl (next-intl's core,
  same ICU catalogues as the web), react-native-mmkv, expo-auth-session,
  expo-secure-store, expo-updates. SDK 58 shipped a React Native release
  candidate at the time; we move with the next SDK upgrade. React for the
  app is a catalog of its own (`catalogs.mobile` in `pnpm-workspace.yaml`),
  because React Native pins the React version it renders with.
- **Login:** authorization code + PKCE in the system browser (Custom Tabs,
  ASWebAuthenticationSession) with the `mobile` client; scopes as the web
  app's, including `offline_access`. The refresh token is stored in the OS
  secure store (Keychain / Keystore, after first unlock, this device only);
  access and ID tokens are kept in memory only. Tokens are refreshed a minute
  before expiry and after a 401, one refresh at a time; a refused refresh
  token (`invalid_grant`) ends the login and wipes the app's data. Logout
  revokes the refresh token, ends the Zitadel session in the browser and
  wipes tokens, cache and cache key.
- **DEV_AUTH for the app:** `POST /api/v1/dev/tokens` (registered only with
  DEV_AUTH, which is refused outside development) mints development tokens
  for a persona, signed by the API; `mintDevToken` lives in
  `@clubadmin/server-kit/dev-tokens` for the web BFF and the API. The persona
  picker and the development-token code are replaced by a stub when bundling
  preview and production builds (`metro.config.js` resolver), so they are not
  in those apps; `pnpm --filter @clubadmin/mobile bundle:check` (CI) fails if
  they are.
- **App sessions:** the API registers a mobile session in the person's
  session index (the same list as browser sessions, `client: "mobile"`) on
  the first request of a Zitadel session from the mobile client (`azp` =
  `AUTH_MOBILE_CLIENT_ID`), with device and app version from `X-Client-*`
  headers (never a device identifier). Revoking it ends the Zitadel session
  and, because that leaves the refresh token valid, puts the session (`sid`)
  on a **deny list** in Valkey for 90 days (the refresh tokens' maximum
  life): the `AuthGuard` refuses every token of that session with
  `401 session_revoked`, freshly refreshed ones included. An instance trusts
  a "not revoked" answer for at most 10 seconds, so revocation takes effect
  within seconds, not after the access token's 10 minutes. The app treats a
  401 that survives a refresh as the end of its login.
- **Cache:** the query cache is persisted to MMKV, **one instance per
  account, encrypted (AES-256)** with a random key in the secure store, in
  the app's cache directory (excluded from iCloud and Android backups;
  `android:allowBackup` is off). Logout, a refused refresh token or another
  account logging in deletes the instance and its key. The cache carries a
  buster of app version and cache schema version, so data written by another
  version is discarded. Cached data is shown immediately on start, refreshed
  in the background, and labelled with its age when older than 15 minutes.
  Writes go through an offline outbox (P1.5, ADR 0035): mutations that
  pause offline, are persisted with this cache and run in order when
  online, each with an Idempotency-Key and the time it was made; signing
  out with unsent writes asks first.
- **Protected people on screen:** screens that show people with protected
  identity block screenshots and screen recordings on Android (`FLAG_SECURE`)
  and blur the app switcher snapshot on iOS, while they are shown.
- **Variants and local development:** `APP_VARIANT` (`development`,
  `preview`, `production`) sets bundle ID, name and URL scheme
  (`clubadmin-dev://`, `clubadmin-preview://`, `clubadmin://`), all
  registered as redirect URIs in Zitadel. Only development-variant builds
  trust Caddy's local CA (a config plugin adds it, and the user CA store, to
  the Android network security config); the development variant is never
  published. Emulators reach Caddy through `adb reverse tcp:443` with the
  names resolved to loopback; `pnpm dev:trust-ca --android` / `--ios`
  prepare the emulator or simulator.
- **Updates:** `expo-updates` with the native fingerprint as runtime
  version, so a JavaScript update only reaches builds with matching native
  code; the update server URL comes from the build environment
  (`EXPO_UPDATES_URL`) and EAS is optional. Running an update server is not
  part of P0.10. Native modules, SDK upgrades and new permissions need a
  store release; everything else can ship as an update. Supported versions
  and server capabilities come from `GET /api/v1/meta/client` (ADR 0029).
- **Rate limits** (`docs/security.md`): requests without a valid login are
  limited per client IP (a rejected token counts as no login); authenticated
  requests per account, plus a much higher per-IP backstop; bulk reads
  (`bulkRead` endpoints: rosters, later exports) also per club and per
  account. First-login provisioning is limited through Valkey across
  instances and fails closed when Valkey is unreachable. Counters are fixed
  windows in Valkey (`apps/api/src/platform/http/rate-limiter.ts`), in memory
  without Valkey.
- **CI:** a release build of the development variant (JavaScript bundled,
  persona picker included) runs on an Android emulator against the local
  services: Maestro flows (personas, protected identity, language, viewing
  as, offline cold start, logout, real Zitadel login) and the cold-start
  measurement. The iOS simulator build is a manual workflow
  (`mobile-ios.yml`).

**Consequences.** One Valkey round trip more per mobile request (the deny
list, at most every 10 seconds per session and instance) and one per
authenticated request (the account counter); about 0.1 ms each locally. A
stolen refresh token can still mint tokens at Zitadel after revocation, but
the API refuses them; a Zitadel-side revocation for login-v1 sessions would
make the deny list unnecessary. The development variant must never be
published (it trusts the local CA and has the persona picker). The about
screen's licence list is generated from the lockfile and checked in CI.
*Amended by ADR 0039 (P1.7):* the app adds `expo-notifications`; with a
server that has push it asks for permission after login, registers its
Expo push token on the account and removes it on logout, and keeps the
token's device ID (not the token) in its settings storage. Universal
links, step-up authentication in the app and server selection for self-hosted installations
([#12](https://github.com/SweRavn/ClubAdmin/issues/12)) are not part of this
decision.
