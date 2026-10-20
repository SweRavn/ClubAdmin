# @clubadmin/mobile

The Expo (React Native) app for iOS and Android. It is created in
[P0.10](../../docs/prompts/P0.10-mobile-shell.md).

Until then this folder has no `package.json`, so it is not a workspace
package and `pnpm licenses:check --mobile` has nothing to check.

Everything bundled into the app must pass the stricter mobile licence check:
no GPL, LGPL or AGPL third-party code (see `docs/licensing.md`).
