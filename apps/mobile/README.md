# @clubadmin/mobile

The Expo (React Native) app for iOS and Android (P0.10, ADR 0028): log in
with Zitadel (PKCE) or, in development builds, as a demo persona; my clubs,
groups and children's groups; group rosters and profiles with the same
visibility as the web; settings, sessions and the About screen with the
source link and third-party licences. Cached data is shown at once, also
offline, from an encrypted per-account cache.

- Screens: `src/app` (Expo Router; it bundles every file there, so tests
  live outside it). Data: `src/api` (the generated client,
  TanStack Query). Login: `src/auth`. Cache: `src/cache`. Language and time
  zone: `src/i18n` (messages from `@clubadmin/i18n`).
- People are shown only through `PersonName` (`src/components/person-name.tsx`,
  text from `personLabel` in `@clubadmin/shared`); user-facing text only from
  the message catalogues (ESLint).
- Everything bundled into the app must pass the stricter mobile licence check:
  no GPL, LGPL or AGPL third-party code (`pnpm licenses:check --mobile`,
  `docs/licensing.md`).
- Running it, variants, emulators and tests: `docs/development.md`,
  "Mobile app".
