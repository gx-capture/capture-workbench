# Capture Runtime v1 Decisions

1. A file-backed repository is sufficient for the local single-user v1 and keeps the
   sidecar independently testable. Atomic replacement prevents partially written JSON.
2. `status` describes terminality while `stage` describes work. Host jobs therefore remain
   `running` at `awaiting_structuring` so existing pollers need only understand the stable
   terminal statuses.
3. Host candidate validation fails closed. Invalid schema or provenance terminates the job at
   `failed/structuring`; hosts use `/structuring-failure` for provider failures before commit.
4. Runtime structuring has no repair fallback. The provider's candidate is validated exactly
   once and invalid output becomes a structuring failure.
5. No Nx Python plugin is installed in the workspace. A manual uv package plus explicit
   `nx:run-commands` targets is used instead of generating unrelated TypeScript files.
6. Multipart uploads are staged to disk in chunks. This avoids a second full-request in-memory
   copy while retaining a strict 50 MiB v1 bound and content-derived digest/sniffing.
7. Host completion, failure, and cancellation are repository-level compare-and-set operations.
   The file-backed v1 therefore has a single durable terminal winner even under concurrent calls.
