# 0007 — REST + OpenAPI from Zod; WebSocket for realtime

**Status:** Accepted

**Context.** Web, mobile and third parties (federations, accounting systems,
clubs' own scripts) consume the API.

**Decision.** REST/JSON under `/api/v1`, schemas in Zod (`packages/shared`),
OpenAPI 3.1 generated from them, typed client generated for our apps. Errors as
RFC 9457 problem details. Keyset pagination, ETags. One WebSocket connection per
client for chat messages and invalidation events.

**Consequences.** Language-neutral, documented API for integrations. tRPC and
GraphQL were rejected (tRPC is TS-only; GraphQL makes authorization and
performance control harder).
