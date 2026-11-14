# 0027 — Web shell: production build, CSP with Trusted Types, and performance budgets in CI

**Status:** Accepted (P0.9).

**Context.** P0.9 asks for a strict Content Security Policy with per-request
nonces and Trusted Types, and for the web budgets in `docs/performance.md`
(LCP < 1.5 s, INP < 200 ms, initial JavaScript < 150 KB compressed for member
pages) to be enforced in CI with Lighthouse CI and a bundle-size check. Three
things got in the way:

- Next.js 16 builds with Turbopack by default. Turbopack's chunk loader and
  some of its runtime write to DOM script sinks without a Trusted Types
  policy, so with `require-trusted-types-for 'script'` the signed-in pages
  stopped working. The webpack build uses Next.js's `nextjs#bundler` policy
  and runs without a single violation.
- `next dev` needs `eval` and injects its error overlay's styles without a
  nonce, so the development server cannot run the production policy.
- The end-to-end tests log in through the DEV_AUTH persona picker, which
  only exists with `NODE_ENV=development`; Lighthouse and the bundle check
  must measure the production build, where DEV_AUTH is (and must stay)
  impossible.
- Lighthouse CI (`@lhci/cli`, Apache-2.0) brings Puppeteer's browser
  downloader with it, whose dependencies have known vulnerabilities without
  fixes (`extract-zip`, `basic-ftp`, `tmp`, `uuid`; OSV-Scanner fails on the
  lockfile), and `parse-cache-control`, whose `package.json` declares "BSD"
  instead of an SPDX identifier (the LICENSE file is BSD-3-Clause).

**Decision.**
- **Production builds use webpack** (`next build --webpack`, the web app's
  `build` script); `next dev` keeps Turbopack. Revisit when Turbopack
  supports Trusted Types.
- **CSP** (`apps/web/src/server/security-headers.ts`, set by `src/proxy.ts`):
  scripts and styles only with the request's nonce (`'strict-dynamic'` for
  scripts), no `unsafe-inline` or `unsafe-eval`, `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'none'`, `form-action` limited to the site
  and the identity provider, and Trusted Types
  (`require-trusted-types-for 'script'`, policies `nextjs` and
  `nextjs#bundler`). `next dev` alone adds `'unsafe-eval'` and inline styles
  and has no Trusted Types. Components must not inject `<style>` elements
  (that is why the Radix menus are non-modal) or set `style` attributes in
  server-rendered HTML.
- **CI runs two web phases**: the Playwright suite against `next dev` with
  DEV_AUTH (as before), then the production build behind Caddy with
  `E2E_PRODUCTION=1` (security headers, no CSP or Trusted Types violations),
  the bundle check and Lighthouse CI. Signed-in pages are reached with a
  test session written directly to Valkey (`apps/web/scripts/test-session.ts`):
  an encrypted session record with a development token the API accepts
  because the API runs with DEV_AUTH in CI. The production web server never
  gains a DEV_AUTH path; the session cannot be refreshed and ends after
  10 minutes.
- **Budgets**: `apps/web/scripts/check-bundle.ts` sums the Brotli-compressed
  size of every script a page makes the browser load before it is
  interactive (script tags and the client chunks named in the RSC payload;
  `nomodule` polyfills excluded) and fails above 150 KB. Lighthouse CI
  (`apps/web/lighthouserc.json`) runs `/` and a group page three times on the
  mobile profile and asserts the median LCP < 1.5 s, CLS < 0.1, script
  transfer < 150 KB and accessibility ≥ 0.95. Reports stay in the CI run;
  nothing is uploaded.
- **INP is measured, not approximated**: Lighthouse's navigation mode has no
  interactions, and its Total Blocking Time (page-load main-thread time,
  dominated by React's hydration) measured about 190–230 ms at P0.9. The
  production end-to-end spec opens and closes the menus and the tooltip on a
  group page with the CPU slowed down 4× (as Lighthouse's mobile profile)
  and fails if any interaction's Event Timing duration (the INP measure)
  reaches 200 ms (P0.9: about 100 ms). TBT stays in Lighthouse CI as a
  warning above 200 ms.
- **Lighthouse CI is not a workspace dependency.** `apps/web/scripts/lighthouse.ts`
  runs it at an exact version with `pnpm dlx @lhci/cli@0.15.1` (the store's
  integrity checks and `minimumReleaseAge` still apply). It is a CI tool
  that never ships and never downloads a browser (it uses Playwright's
  Chromium), so its dependency tree stays out of the lockfile, the licence
  check and OSV-Scanner. Update the version in that script.

**Consequences.** The production build is slower than with Turbopack. Heavy
client libraries have to stay out of the initial bundle: Radix UI menus load
on first use (a plain button is rendered on the server), the
protected-identity tooltip is a small component of our own, and list
virtualisation loads only for long lists. Anything that writes to a DOM
script sink without a policy fails the production end-to-end check.
