# 0001 — Record architecture decisions

**Status:** Accepted

**Context.** The project will be built over a long time, partly by AI agents
working from prompts, partly by contributors. Decisions must be discoverable.

**Decision.** Record significant decisions as ADRs in `docs/adr/`. Prompts in
`docs/prompts/` reference ADRs instead of repeating them.

**Consequences.** Changing a decision means writing a new ADR and updating
`architecture.md` in the same PR.
