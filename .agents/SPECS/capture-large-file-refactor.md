# Capture Workbench Large-File and DDD Refactor Spec

## Purpose

Reduce mixed-responsibility modules across `apps/` and `packages/` while preserving
published facades, runtime contracts, persistence formats, process/security
boundaries, and user-visible behavior. The refactor prioritizes the largest
human-maintained files and leaves generated artifacts and release outputs alone.

## Scope

- Include all human-maintained, tracked source, tests, scripts, documentation,
  and fixtures under `apps/` and `packages/`.
- Exclude generated contract/codecs/schema snapshots, build/dist/target output,
  binaries, virtual environments, caches, and third-party files.
- Process desktop smoke harnesses after the production lanes are stable.
- Do not add a package or upgrade dependencies.

## Public and behavioral contract

- Preserve published import paths, package exports, Angular DI tokens, custom
  element DOM/property/event behavior, Tauri commands, runtime wire/schema
  shapes, contract-set SHA-256, persistence formats, and SDK APIs.
- Keep `capture_runtime.contracts` as the canonical cross-language contract
  source and keep generated artifacts byte-stable.
- Keep `capture_runtime.contract_set`, SDK client import paths, and public Rust
  module paths as compatibility facades when internals move.
- Do not introduce new async/Promise boundaries in Angular product code.

## Structure and ownership

- Reuse existing `contracts`, `constants`, `services`, `controllers`, `routes`,
  `storage`, `structuring`, `ollama`, `workers`, and `components` conventions.
- Add feature/domain/application/infrastructure subfolders only where a real
  bounded context or existing ownership boundary requires them.
- Angular components remain presentation-focused. Injectable collaborators own
  orchestration and adapters; signals and `rxResource` represent view state;
  RxJS represents event, polling, cancellation, and workflow pipelines.
- Keep public facade classes thin while moving implementation behind private,
  testable seams.

### Implementation lane ownership

Each lane owns only the paths listed below; the root agent owns integration,
public entrypoints, generated assets, project configuration, and final
verification.

| Lane | Owned paths |
| --- | --- |
| Angular host | `apps/capture-workbench/src/app/services/desktop-workspace.store.ts`; `apps/capture-workbench/src/app/services/desktop-workspace-*.ts`; `apps/capture-workbench/src/app/services/desktop-workspace.selectors.ts` |
| Angular package | `packages/capture-workbench-ui/src/lib/capture-angular/services/capture-workflow/capture-workflow.service.spec.ts` |
| Runtime installation | `packages/capture-runtime/src/capture_runtime/engine_installation.py`; `packages/capture-runtime/src/capture_runtime/_engine_installation_*.py` |
| Runtime contracts/storage | `packages/capture-runtime/src/capture_runtime/contract_set.py`; `packages/capture-runtime/src/capture_runtime/_contract_set_bundle.py`; `packages/capture-runtime/src/capture_runtime/storage/streaming_repository.py`; `packages/capture-runtime/src/capture_runtime/storage/_streaming_*.py` |
| Tauri library | `apps/capture-workbench-desktop/src-tauri/src/library.rs`; `apps/capture-workbench-desktop/src-tauri/src/library/*.rs` |
| Tauri runtime client | `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs`; `apps/capture-workbench-desktop/src-tauri/src/runtime_client/*.rs` |
| TypeScript SDK | `packages/capture-runtime-client/src/client.ts`; `packages/capture-runtime-client/src/private/*.ts` |
| Python SDK | `packages/capture-runtime-client-python/src/capture_runtime_client/client.py`; `packages/capture-runtime-client-python/src/capture_runtime_client/_*.py` |
| Smoke/documentation | only explicitly assigned smoke scripts, fixtures, and public API documentation files; no production lane overlap |

Workers do not modify `.agents`, package/project configuration, generated
contracts/codecs/assets, Java DTOs, or public package entrypoints. Every lane
must report its changed paths, commands, verification result, and residual
risk before the root agent accepts it.

## Documentation

- Document public TypeScript, Python, Java, and Rust APIs, public DI tokens,
  Tauri commands, custom element contracts, and cross-language invariants.
- Add focused comments for security, recovery, persistence, and state-machine
  rules when the rule is not obvious even if the helper is private.
- Do not add boilerplate documentation to generated files or obvious private
  helpers. Produce an advisory coverage report; do not make it a blocking CI
  gate in this refactor.

## Acceptance criteria

- P0 modules no longer mix independent domain, orchestration, I/O, and adapter
  responsibilities; each remaining facade has a small stable public surface.
- Existing public API and behavior tests pass without changing public names or
  serialized formats.
- Contract-set hashes and generated artifacts remain unchanged unless a test
  proves an existing baseline was already inconsistent.
- High-risk lifecycle, recovery, redaction, SSE resync, installation security,
  and SDK compatibility behavior is covered at public seams.
- Each implementation lane has an explicit file ownership list and can be
  independently reverted.

## Baseline

- HEAD: `351a53bbab6b1de2622d00f01d607206c9a9c6ea`
- Tracked `apps/` and `packages/` files: 406
- Contract-set SHA-256 in runtime, TypeScript, Python, and Java assets:
  `b28366f022533192c063056bbf64cacfd09390815c65408066369dd61094e278`
- `capture-angular:test`: 9 files, 64 tests passed
- `capture-workbench:test`: 4 files, 46 tests passed
- `capture-angular:async-boundary-check`: passed, 2174 approved occurrences
- `capture-runtime:check-contracts`: passed
- TypeScript SDK tests: 16 passed
- Python SDK tests: 15 passed
- Java SDK tests: 9 passed

## Verification

Use focused Nx targets after every lane, then run cross-project verification at
phase boundaries. Always finish with `git diff --check`, explicit public export
comparison, contract checks, and independent root-agent reruns of worker claims.
