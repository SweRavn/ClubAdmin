# 0029 — API compatibility: `/api/v1` only grows

**Status:** Accepted (P0.10).

**Context.** The web app is deployed together with the API, so the two always
match. Installed mobile apps do not: people update weeks or months late, some
never, and an app-store release takes days. Self-hosted servers add the
opposite case: a new app from the store meets an older server. Without rules,
every API change either breaks installed apps or forces an app-store update.

**Decision.**
- **Within `/api/v1` the API only grows.** Allowed at any time: new endpoints,
  new optional response fields, new optional query parameters and request
  fields, new problem types, and new values in enums (group kinds, roles and
  the like; clients must cope, below). A **breaking change** is anything else:
  removing or renaming an endpoint or field, changing a field's type,
  format or meaning, making a parameter or request field required, narrowing
  what a request accepts, or removing an enum value from a response.
- **How to change something anyway:** add the new field or endpoint next to
  the old one, mark the old one `deprecated` in its Zod schema (it shows in
  OpenAPI), keep serving both, and remove the old one only when no supported
  app version uses it. A change that cannot be made that way waits for
  `/api/v2`, which would be served next to `/api/v1` for at least the support
  period below.
- **Support period:** the API keeps working for every app version released in
  the last **12 months**, and for anything newer than the `minimumVersion` it
  announces. Raising `MOBILE_MIN_VERSION` is a release decision noted in the
  changelog; it is the emergency exit (a security problem in the app), not
  the way to ship a breaking change.
- **CI enforces it:** `pnpm api:breaking` runs oasdiff (Apache-2.0, through
  Go's module proxy at an exact version, so it is not in the lockfile) on
  `packages/api-client/openapi.json` against the base commit and fails on
  breaking changes. A decided exception is a line in
  `packages/api-client/breaking-changes-allowed.txt` that names this ADR, a
  later ADR or an issue; lines are removed once the change is on `main`.
- **Clients are tolerant:** they ignore unknown response fields, show a
  neutral fallback for enum values they do not know (never crash or hide the
  item), and fall back to the problem's translated `title` for problem types
  they do not know. The mobile app parses responses with the generated types,
  not with strict Zod schemas. Tests feed both apps responses with extra
  fields and unknown enum values.
- **Apps learn about the server from `GET /api/v1/meta/client`:** the minimum
  and recommended app version per platform (configuration:
  `MOBILE_MIN_VERSION`, `MOBILE_RECOMMENDED_VERSION`, per-platform overrides,
  store URLs), feature flags (`FEATURE_FLAGS`) and the server's
  **capabilities** (`features`, from `SERVER_FEATURES` in `packages/shared`).
  A new app hides what an older server lacks instead of calling it. Feature
  and flag names are strings, never enums, so old apps ignore new ones. A
  capability is added with the endpoint or behaviour it announces and never
  removed or renamed within `/api/v1`.
- **New app, older server:** the app assumes only the capabilities the server
  lists. Whether the store app can connect to self-hosted servers at all is
  not decided ([#12](https://github.com/SweRavn/ClubAdmin/issues/12)); this
  policy works either way.

**Consequences.** Some response shapes keep deprecated fields for a year.
Renames cost an extra field. Every API pull request runs the oasdiff check
(Go toolchain on the CI runner). App releases can mostly ship as
over-the-air JavaScript updates (ADR 0028), because the API they talk to
does not move under them.
