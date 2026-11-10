# Capture Runtime Phase 2 hardening decisions

Status: accepted 2026-09-10; first shipped in 0.4.2. The
[Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md) owns policy,
owner paths, the runtime process lifecycle, compute truth, acceptance and
identity. The open work is [#247](https://github.com/gx-capture/capture-workbench/issues/247); the
[release runbook](../GUIDES/release-runbook.md) owns the release procedure.

## Decisions

1. **One producer, no second coordinator.** The producer owns OCR, compute,
   model provenance, process lifecycle, version identity, and release evidence.
   Each consumer runs its own acceptance gate and writes its own manifest.
   Cert Prep and GX Law Prep receive semantic adapters and own durable domain
   data only. Runtime jobs, listeners, and staging are ephemeral; durable
   runtime/model caches are retained.

2. **Deepening is convergence/replacement.** The implementation worker starts
   from current symbols, migrates callers through one external seam, hides
   platform/transport/test adapters, and deletes obsolete helpers after
   replacement tests. Convenience wrappers that leave policy in hosts are not
   considered a deep module.

3. **OcrPipeline alternatives and choice.** The SPEC records three materially
   different designs:
   - O1 is one terminal extract(request, engine) -> outcome operation.
   - O2 is a progressive open -> next_page -> finish page session.
   - O3 is a pure projection reducer whose callers own OCR collection.

   Choose O1. The repository already has
   packages/capture-runtime/src/capture_runtime/ocr/infrastructure/ocr_projection.py::OcrPipeline,
   an OcrEnginePort, producer worker/extractor adapters, and several callers.
   One terminal operation hides page order, rasterization, normalization,
   provenance, cancellation, and typed failure. Current
   normalize/serialize/failure helpers are migration/deletion surface, not
   permanent seams.

4. **One launch path with Job cleanup.** The product owner decided on
   2026-11-10 that the hosts keep the one launch path they use and that the
   launcher has no group lifecycle, launch journal, or restart reconciliation.
   `capture-sidecar-launcher` starts each root suspended, assigns it to a new
   unnamed no-breakaway Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, checks
   the assignment, and only then resumes it. A host launches the Capture
   runtime with `launch_sidecar` or `launch_sidecar_with_observer` (3 attempts
   within 60 seconds, a fresh loopback port and bearer token per attempt) or
   owns a process directly through `OwnedRuntimeSession::spawn` or
   `OwnedSidecarProcess::spawn`. LAW runs each of its runtime processes as a
   separate owned session.

   Why: when a host exits for any reason, the system closes its Job handle and
   stops the runtime and every descendant, which also releases their
   listeners. The next launch uses a new port and token, so an old listener
   cannot pass the readiness check, and the runtime's startup sweeps remove
   `_MEI*` folders, upload and spool files, interrupted installs, and engine
   install leftovers. Nothing a crash leaves behind blocks the next start, so a
   durable record of launched processes has nothing to clean. A group protocol
   with a journal would leave its own records behind after every crash and
   would need that reconciliation in all three hosts.

   Consequences: the launcher writes nothing to disk and keeps no record of
   what it started. After a power loss it relies on every process being gone.
   Ollama's `ollama.pid` can outlive a power loss. The file also records the
   process creation time, so a PID that Windows has given to another process
   is recognized: the runtime removes the stale file and starts Ollama.

5. **Existing native exports and callers are the boundary.** src/lib.rs
   exports `OwnedRuntimeSession`, `OwnedSidecarProcess`,
   `RuntimeTerminationProof`, `RuntimeCleanupError` and
   `RuntimeCleanupErrorKind`; src/launcher/ owns SidecarLaunchSpec,
   LaunchOptions, LaunchedSidecar, launch_sidecar, and
   launch_sidecar_with_observer; desktop Tauri src/state.rs, src/launcher.rs,
   and src/commands.rs are callers. The implementation uses those paths and the
   existing launcher/desktop Cargo targets. It does not invent a desktop
   process owner.

6. **Contract identity remains fixed.** API 2.0, raw/structured schema 2,
   and CaptureOcrProjectionV3 schema 3 remain the floor; the runtime contract-set hash is `contractSetSha256` in `packages/capture-runtime-client/package.json` (it changes only with a contract release). The
   first implementation slice upgrades Nx 23.1.0 to 23.1.2 in
   package.json and pnpm-lock.yaml and extends
   tools/release/version-sources.ts plus its existing
   capture-tools:release-version-test regression test. It enumerates runtime,
   document/projection schema, TS/Python/Java clients, Rust launcher/crate,
   Workbench packages/assets, manifests/locks/catalogs, and npm, PyPI, Maven,
   crates.io, and GitHub channels. A missing target such as
   capture-runtime:version-check is discovery-and-stop, not a new target.

   The compute real-proof owner is
   `packages/capture-runtime/src/capture_runtime/ocr/infrastructure/ocr_preflight.py:OcrComputePlan.select`
   with `OcrGpuCapabilitySnapshot`. Its focused regression is
   `packages/capture-runtime/tests/unit/test_ocr_compute_plan.py:test_positive_unavailable_dgpu_selects_usable_igpu`:
   a positively unavailable dGPU plus a usable mapped iGPU selects the iGPU
   DirectML mapping, not CPU; an indeterminate dGPU remains fail-closed. The
   existing full verification is
   `corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`.

## Rejected framings

- Treating a green deterministic PR or completed local-probe Phase 1 as
  published/release proof.
- Choosing a run-shaped OcrPipeline without the three alternatives,
  comparison, and current-owner migration.
- Adding a coordinator around desktop state instead of using
  OwnedRuntimeSession and its launcher exports/callers.
- Letting a timeout, exception, unknown adapter, or incomplete identity guess
  CPU; or retrying CPU/another GPU after selected DirectML failure.
- Persisting tokens, OCR, source/model paths, raw process diagnostics, or host
  process handles.
- Treating a PID, parent process, executable name, port, or directory name as
  ownership proof.
- Naming a Job, adopting a Job after a restart, or weakening
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- Rebuilding or republishing between candidate acceptance and publication,
  accepting a local candidate as published acceptance, or moving the stable
  pointer before published acceptance.
