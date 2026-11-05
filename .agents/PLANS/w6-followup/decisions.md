# Decisions

Change mode: mixed (edit current owners, delete superseded wrappers and state policy).
Risk: high; coordinated lifecycle refactor. Keep locks, IO, timestamps, persisted shapes and async task registry in their current owners; pure aggregates decide legal state/progress, application use cases own coordination. Do not duplicate policies or introduce parallel state stores. Engine result carriers move inward with their metadata intact. Vocabulary derives expected values from canonical code/data, never documentation prose.

Rejected: adding another forwarding layer; changing public contracts or durable formats; broad unrelated cleanup.
