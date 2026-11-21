# Nx workspace guidance

- Use `pnpm nx` for project discovery and all build, lint, test, and packaging targets.
- Use `pnpm nx show project <name> --json` for resolved target configuration.
- Use Nx generators with `--dry-run` and `--no-interactive` before creating Angular projects.
- The Capture Workbench package is framework-facing only; native process, filesystem, and model lifecycle belong to `capture-runtime` or the Tauri harness.
- The published Web Component is a host-framework-independent custom element. Consumer verification must use the packaged loader, public DOM/property/event API, and runtime contract; do not block a consumer solely because its host uses a different Angular major version. Treat Angular-version compatibility as a defect only when an actual build or runtime verification demonstrates a failure.
- Never log or persist sidecar bearer tokens.
- Runtime jobs are ephemeral; host applications own durable source and domain persistence.
- Tests must not leave temporary files. A TypeScript test file that creates temp files imports `tools/test-temp-root.ts` first (a private temp root removed on exit); where module-boundary rules forbid importing `tools/` (an e2e project), the test target preloads the guard with `node --import ./tools/test-temp-root.ts` and the test still removes what it creates; pytest uses `tmp_path_retention_policy = "failed"` (passed tests' dirs are removed; only failed ones from the last 3 sessions stay). Never use `"none"`: it disables pytest's session lock, so concurrent pytest runs delete each other's temp dirs. Local manual runs of `verify-release-model-candidate` (and its speech preflight), `progressive-audio-oracle` and `clean-consumer-smoke` do not delete their large trees: each run keeps a fresh directory with a `kept-run-tree.json` marker under the kept-trees root (`CAPTURE_KEPT_RUN_TREES_ROOT`, default `.kept-run-trees` beside the checkout), and the person deletes them one at a time when the machine is idle with `pnpm run kept-run-trees -- --list` / `-- --remove <path>`; on GitHub runners (`GITHUB_ACTIONS=true`) they are removed as before.

# Dead code

- Dead code is gated as a ratchet. `tools/quality/dead-code-baseline.json` lists the known findings of knip (TypeScript; `knip.json`), vulture (`capture-runtime` and `capture-runtime-client-python` `src`) and every Rust `#[allow(dead_code)]` (none remain). A new `allow(dead_code)` fails: delete the dead code, or put test-only code under `#[cfg(test)]`. `pnpm run dead-code:check` fails only on new findings. CI's `checks` job runs it with `--ci`, which also fails when a baseline entry is gone, so run `pnpm run dead-code:update` after deleting dead code. `production` and `python` entries mean only tests still use that code. The Python client is a published library, so only its high-confidence findings count.
- In `knip.json`, keep production (`!`) and non-production project globs disjoint; an overlap silently drops those files from the production pass. `capture-runtime-client` and `capture-workbench-ui` are their own knip workspaces (their `package.json` exports are the entries).
- When a design or release channel is replaced, delete the old path, its config, CI and release steps, and its docs in the same change. Do not keep it "for compatibility" unless a named consumer still needs it. When a tool cannot see a real use (a CLI entry, a framework callback), add a `knip.json` entry or a vulture decorator ignore in `tools/dead-code-gate.ts`; never add new dead code to the baseline.
- `.claude/settings.json` runs the check as a Claude Code Stop hook before a turn that changed code ends.

# Pinned values

- Tests, doubles and fixtures must not copy the current release version or generated artifact hashes. Import `RELEASE_VERSION` / the generated constant (or read its recorded asset), or use an obviously synthetic value for a self-consistent fake. Arbitrary older versions used as scenario data are allowed.
- `pnpm run pinned-values:check` rejects new findings against `tools/quality/pinned-values-baseline.json`. CI uses `--ci` to also reject vanished baseline entries; run `pnpm run pinned-values:update` after fixing them. Finding identities omit the value so releases do not invalidate the baseline.
- Scenario data may use any other version ("a mismatched version", "an older baseline"). Choose one below the current release or clearly synthetic: a literal that equals a later release fails the gate in that release's preparation.

# Naming

- A name says what the thing is or does. It does not name a vendor, engine, model, or technology unless that is exactly what it denotes and it would be wrong for any other. Identifiers that leave the process (contract values, requirement ids, error codes, environment variables, stored fields, target names) are named by function.
- No name of a past design, phase, slice, or plan label in an identifier, file name, target, evidence field, or environment variable.
- One term per concept across runtime, contract, clients, hosts, UI, and documents. The terms are in `docs/domain/` and the glossary `.agents/PLANS/ddd-refactor/glossary.md`.
- Use `text-recognition` for the OCR requirement and provenance engine, and `directml` for provenance from DirectML execution.
- A name states its scope. Code that handles every capture kind is not named for one. A target says what it runs against (fixture runtime or real engines; dev server, packaged Desktop App, or installed application) and whether a release requires it.
- When behaviour changes so that a name stops being true, rename it in the same change, including contract values while a contract-changing release is open. A misleading name is a defect, not a style matter.
- Renamed or retired names do not come back: `pnpm run retired-names:check` rejects them. When a change retires a name, add it to `tools/quality/retired-names.json` in the same change; after removing remaining occurrences run `pnpm run retired-names:update` (CI runs the gate with `--ci`).
- `.claude/settings.json` runs the retired names check as a Claude Code Stop hook when the checkout has changes.

# Speech development tests

Speech recognition ships as two packs, the `cuda` and `cpu` contents of
`speech-recognition`, and what runs by default follows the installed pack. A
machine with the NVIDIA driver (`System32\nvcuda.dll`) installs `cuda`: TEA-ASR 1.1
on CUDA, and that same checkpoint on CPU after a classified GPU failure. A machine
without it installs `cpu`: TEA-ASR 1.1 mini on CPU. `CAPTURE_SPEECH_RECOGNITION_VARIANT`
(`auto`, `cuda`, `cpu`) overrides the choice at install time; the installed pack
is never re-detected. An explicit `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1`
on a `cpu` installation fails the capture with `requirement_unavailable`; mini
runs on either pack. Do not "fix" the `cpu` pack back to TEA-ASR 1.1.

A development test that transcribes real audio uses TEA-ASR 1.1 mini on CUDA
and checks provenance `tea-asr-1.1-mini` with device `cuda`. Set
`CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini` and
`CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK=false`. Follow
`.agents/RESEARCH/tea-asr-1.1-mini-gpu-2026-11-04.md`. Release smokes and the
private speech fixture stay on `tea-asr-1.1` / `cuda`, and those smokes force the
`cuda` pack: the candidate verifier and `real-media-smoke` set the variant. The
localhost installation journey checks that the installed speech pack matches the
variant override or the NVIDIA driver default. The localhost execution journey
checks the pack before capture and verifies speech provenance from that pack
(`tea-asr-1.1` / `cuda` or `tea-asr-1.1-mini` / `cpu`). The `cpu` pack has no frozen transcript: the
candidate verifier also installs the candidate's own `cpu` pack and checks
provenance `tea-asr-1.1-mini` / `cpu`, and its release evidence is one manual
mini transcription on CPU, recorded in the release runbook.

# Architecture

- `docs/architecture/` holds generated diagrams of today's dependencies (Nx projects, runtime contexts, UI modules). Never edit them by hand: run `pnpm run architecture:update` after changing dependencies; CI's `checks` job fails when they are stale (`architecture:check`).
- The rules live in `packages/capture-runtime/importlinter.toml` (runtime contexts, `capture-runtime:lint-architecture`), `sheriff.config.ts` (UI modules) and the `depConstraints` of `@nx/enforce-module-boundaries` in `eslint.config.mjs` (Nx `type:*` tags). Decisions are in `.agents/PLANS/ddd-refactor/` and `.agents/DECISIONS/`.
- Known exceptions (`ignore_imports`, ESLint disables or bulk suppressions of the Nx and Sheriff rules) are a ratchet in `tools/quality/architecture-exceptions-baseline.json`: a new one fails; fix the import instead. After removing one, run `pnpm run architecture-exceptions:update` (CI runs the gate with `--ci`).
- The repo wiki's overview pages (Home, 工作計畫 from the issues' sub-issue and "blocked by" relations, 架構總覽 from the architecture graph) are generated by `tools/wiki-overview.ts` in `.github/workflows/wiki-overview.yml` (daily, on issue changes and on graph-affecting pushes to `main`). Never edit them by hand; change the generator instead.
- `.github/workflows/architecture-diff.yml` (`tools/architecture-diff.ts`) rewrites the section between `<!-- architecture:start -->` and `<!-- architecture:end -->` in each pull request description: the touched nodes, their direct dependencies and the edges the PR adds or removes. The graph levels are configured in `architecture-graph.config.json`.
- The Stop hook also runs `node tools/architecture-graph.ts --hook`: the diagram check and the exception gate, plus the runtime contracts when runtime Python changed.

# Verification in two layers

- Layer 1 is the dev server, frontend and backend: whatever can be verified there is verified there first. Layer 2 is the Desktop App, only for what layer 1 cannot prove: WebView2 behaviour, native dialogs and drag and drop of native paths, the installer, process cleanup on exit, pixel baselines. Before planning or asking for a Desktop App run, list what the run must prove and move every item layer 1 can prove to layer 1. A Desktop App run needs a build, opens windows on the user's machine and takes long; a dev-server run is headless, cheap and repeatable.
- Calibrate screens and discuss screen behaviour on the dev server first: `pnpm nx run capture-workbench-e2e:preview` serves the Workbench at `http://localhost:4300` with the simulated desktop backend of the browser e2e (`apps/capture-workbench-e2e/src/fake-desktop.ts`); scenarios are listed at `/__preview`, with the query parameters that change the simulated timing (`speed`, `startDelay`). Record a run with headless Playwright against that URL.
- A new screen state that people need to look at becomes a scenario in `apps/capture-workbench-e2e/src/preview-scenarios.ts` or an option of the simulated backend, not a one-off script.
- Real engines do not by themselves need the Desktop App. The backend is verified at the runtime API (`apps/capture-workbench-desktop/scripts/real-media-smoke.ts`: installation, OCR and transcription; `real-ollama-smoke.ts`: structuring with the real model). For renderer-plus-host verification against the deterministic fixture runtime without the Desktop App, `pnpm nx run capture-workbench-e2e:preview-dev-host` serves the Workbench against the dev host with the deterministic fixture runtime via `apps/capture-workbench-e2e/dev-host-preview-server.ts` (`capture-workbench-dev-host`, built via `pnpm nx run capture-workbench-desktop:build-dev-host`), and `pnpm nx run capture-workbench-e2e:e2e-dev-host` runs the Playwright `chromium-dev-host` project against it. For renderer-plus-host verification with real engines on localhost, `pnpm nx run capture-workbench-e2e:smoke-real-engines-installation` runs the manual installation journey on empty app data for installation/catalog/worker/model delivery changes and before release; it proves downloads, verification, cancel/retry/re-attachment, model installation and first start/restart with persistent verification records. `pnpm nx run capture-workbench-e2e:smoke-real-engines-execution` runs the execution journey for every runtime/UI fix and before release on installed app data from the same build; it fails with reinstall guidance when catalog-bound requirement readiness or the selected installed model does not match, never installs, and proves OCR, speech/speakers, structuring, device checks, edit/restore/export, persistence, deletion and restart after deletion. Both journeys run (`apps/capture-workbench-e2e/src/real-engines.spec.ts`) against `capture-workbench-dev-host` and the staged product runtime. The installation journey installs the structuring model, and the execution journey runs it. A change to code or data that a worker packages changes that worker's archive, so execution then needs a fresh installation journey first; other runtime changes leave the archives byte-identical ([#478](https://github.com/gx-capture/capture-workbench/issues/478)). Slice 3 of `.agents/DECISIONS/dev-host.md` (tracked in [#418](https://github.com/gx-capture/capture-workbench/issues/418)) still moves the layer-1 parts of the OCR Desktop smoke there.

# Release and CI guidance

- Follow `.agents/GUIDES/release-runbook.md` for the current release state, the publish procedure, and known pitfalls.
- Releases publish npm (GitHub Packages), PyPI, and crates.io packages. There is no Java SDK: hosts reach the runtime through the npm packages, the Python client, or the launcher crate.
- Push CI on `main` is release evidence: release candidates verify it for their source commit, so never skip or weaken it. Only `main` runs the full verification (every project: builds, packaging, engine workers, installer, desktop product, reference flow). A pull request, and `pnpm run verify:affected` locally, run the same lint, type-check, and unit-test targets for the projects the change affects (`nx affected`, base `origin/main`; the local script includes uncommitted files, and the pull request pins `HEAD`). Contract, architecture, and dead-code gates still run for the whole workspace on a pull request. Before merging a change to builds or packaging, run the affected build targets locally, since its pull request does not.
- Tests check behavior and workflow contracts, never documentation prose (a TODO checkbox or README wording must not fail CI) and never implementation text alone: a test that only regex-matches a script's source breaks on harmless refactors and passes when behavior breaks.
- Real OCR journeys (desktop acceptance, practical installed OCR, runtime PDF OCR E2E) are local and manual; their file headers describe the steps and inputs.
- Launcher `cargo test` is the only place failed tests are retried; fix timing-sensitive tests at the source rather than adding retries elsewhere.
