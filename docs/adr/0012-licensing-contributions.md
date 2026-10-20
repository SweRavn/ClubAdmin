# 0012 — AGPL-3.0, dependency allow list, contributions, app-store permission

**Status:** Proposed — maintainer must decide CLA vs DCO before external contributions.

**Context.** The project is AGPL-3.0. Dependencies must be compatible. App
stores impose terms the FSF considers incompatible with (A)GPL. A future
commercial licence would require control of copyright.

**Decision (proposed).**
- `AGPL-3.0-only` for all code in this repository.
- Dependency allow list and CI licence check (`docs/licensing.md`).
- An additional permission (AGPL section 7) allowing distribution of the mobile
  apps through app stores, added before the first external contribution.
- DCO sign-off for contributions, **unless** the maintainer wants the option of
  dual licensing, in which case a CLA.
- Visible "Source code" link in all clients (AGPL section 13).

**Consequences.** Hosted forks must publish modifications. The decision on
CLA vs DCO is hard to change later.
