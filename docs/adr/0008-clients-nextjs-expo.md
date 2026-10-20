# 0008 — Next.js for web, Expo for iOS/Android

**Status:** Accepted

**Context.** Web is the first test target; admin screens are data-heavy; public
club pages need SEO; mobile apps need push, camera, offline.

**Decision.** Next.js (App Router, Server Components) for web, also acting as
backend-for-frontend for sessions. Expo (React Native) for iOS and Android.
Both use the generated API client, TanStack Query and shared i18n catalogues.
UI components are not shared between web and mobile at first (different
primitives); logic, hooks and schemas are.

**Consequences.** Two UI codebases, one data layer. EAS Build is optional;
apps can be built in CI with open tooling.
