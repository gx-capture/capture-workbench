# Decisions

Change mode: mixed (edit current owners, delete superseded wrappers and state policy).
Risk: high; coordinated lifecycle refactor. Keep locks, IO, timestamps, persisted shapes and async task registry in their current owners; pure aggregates decide legal state/progress, application use cases own coordination. Do not duplicate policies or introduce parallel state stores. Engine result carriers move inward with their metadata intact. Vocabulary derives expected values from canonical code/data, never documentation prose.

Rejected: adding another forwarding layer; changing public contracts or durable formats; broad unrelated cleanup.

The second review replaces concrete service dependencies with per-use-case structural ports and finite callbacks. Shipping reading-order/evidence algorithms move inward unchanged; compute selection, window slicing and batch budgets use domain decisions. Native discovery, IO, locks and worker transport remain adapters. Completed events carry datetime without millisecond truncation. Chinese content is written as UTF-8 and concept IDs are retained.
