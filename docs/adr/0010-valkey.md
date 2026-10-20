# 0010 — Valkey for cache, rate limiting and pub/sub

**Status:** Accepted

**Context.** Permission-set cache, rate limiting and WebSocket fan-out across
API instances need a fast shared store.

**Decision.** Valkey (BSD-3-Clause, Linux Foundation). Nothing in Valkey is a
system of record: it can be wiped at any time without data loss.

**Consequences.** Not backed up. Redis 8 (AGPL option) would also be licence
compatible; Valkey chosen for permissive licence and governance.
