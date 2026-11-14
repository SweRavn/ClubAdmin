# 0012 — AGPL-3.0, dependency allow list, DCO, app-store permission

**Status:** Accepted

**Context.** The project is AGPL-3.0. Dependencies must be compatible. App
stores impose terms the FSF considers incompatible with (A)GPL. The maintainer
has no plans to relicense.

**Decision.**
- `AGPL-3.0-only` for all code in this repository.
- An additional permission under AGPL section 7
  (`LICENSE-APP-STORE-EXCEPTION.md`) allows distributing the client apps through
  app stores, on condition that the full source stays freely available.
- Dependency allow list and CI licence check (`docs/licensing.md`); a stricter
  list for the mobile bundle: no third-party GPL/LGPL/AGPL code, since our
  exception cannot cover it.
- Contributions via DCO sign-off (no CLA).
- Visible "Source code" link in all clients (AGPL section 13).

**Consequences.** Hosted forks must publish modifications. Without a CLA,
relicensing later would need consent from every contributor; accepted.
