# W6 follow-up specification

Resolve issue #174 review findings: production use cases, aggregate-owned state rules, inward-facing engine ports, and complete concept mappings.

Preserve HTTP/SSE/worker contracts, contract hash, persisted JSON, lock scope, idempotency, cancellation and task scheduling. Existing repositories remain persistence owners. No new architecture or dead-code exceptions.

Acceptance: production paths use business operations and domain policies; terminal captures reject late events; ordered ingestion/session submissions and replay/reload remain correct; application ports do not import engine infrastructure result types; block kinds, requirement IDs, canonical worker stages and problem codes each map exactly once. Full runtime unit/integration, lint/typecheck/contracts and architecture/dead-code gates pass.

Follow-up review scope (2026-11-05): repair UTF-8 Chinese labels and diagrams without changing concept IDs; restore glossary coverage including errors; inject finite ports/callbacks instead of a concrete service; wire shipping compute/layout/evidence/window/batch policies without substituting toy algorithms; model installation routes use real use cases and a domain lifecycle. Re-run all runtime gates and update PR #290 / issue #174.
