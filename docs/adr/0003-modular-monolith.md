# 0003 — Modular monolith on NestJS + Fastify

**Status:** Accepted

**Context.** Many features, a small team, self-hosters who need simple
operations, and strict performance goals.

**Decision.** One API deployable (NestJS with the Fastify adapter) plus a worker
process sharing the same code. Modules own their tables, expose services,
communicate via in-process domain events persisted through a transactional
outbox. Lint rules forbid importing another module's internals.

**Consequences.** Simple deployment and debugging, in-process calls (fast).
Streaming or chat can be split out later behind the same interfaces if needed.
Module discipline must be enforced by lint and review.
