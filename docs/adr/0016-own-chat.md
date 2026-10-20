# 0016 — Build chat in-house instead of Matrix

**Status:** Accepted

**Context.** Teams need WhatsApp-like chat rooms. Room membership must follow
team membership and roles automatically, child-safety rules must be enforced,
moderation and GDPR deletion must work. Matrix is powerful but heavy to run,
federated by design and fights these requirements; end-to-end encryption would
prevent moderation and safeguarding review.

**Decision.** Chat built on Postgres (messages partitioned by month) +
WebSocket + Valkey pub/sub + push. Rooms are linked to teams/roles (auto
membership) or ad hoc. Encryption in transit and at rest, not end-to-end.

**Consequences.** We own the chat implementation; scope is kept to text,
images, files, reactions, replies, read receipts. Message tables need
partitioning and retention from the start.
