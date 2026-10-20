# Implementation prompts

Each work package in [`../roadmap.md`](../roadmap.md) gets one prompt file here,
named `<id>-<slug>.md` (e.g. `P0.4-database-foundation.md`). A prompt is handed
to an AI coding agent (or a human contributor) together with `CLAUDE.md`, and is
also posted as a GitHub issue.

Prompts reference the foundation documents and ADRs instead of repeating them.
Keep each prompt small enough for one reviewable PR (a few days of work at most).

Use [`_template.md`](_template.md). Prompt files are written just before the
work package starts, so they reflect what already exists in the code.
