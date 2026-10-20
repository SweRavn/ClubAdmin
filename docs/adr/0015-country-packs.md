# 0015 — Country packs for country-specific rules

**Status:** Accepted

**Context.** Background checks, grants (LOK-stöd), personal identity numbers,
consent ages, holidays and locale defaults differ per country.

**Decision.** `packages/country-packs/<cc>` implement typed interfaces
(`ClearanceRules`, `GrantRules`, `PersonalIdFormat`, `AgeRules`,
`LocaleDefaults`, `FederationExport`). The club's `country` selects the pack.
The core never branches on country codes. Sweden (SE) first, Norway (NO) second
(the demo data includes a Norwegian club to keep the core honest).

**Consequences.** Adding a country is additive. Rules that change yearly
(grant thresholds) are data with validity dates inside the pack.
