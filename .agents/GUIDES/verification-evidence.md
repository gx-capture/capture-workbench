# Verification evidence

## Scope and decision

Choose the cheapest check that can observe a claim across `apps/capture-workbench-e2e/`, `apps/capture-workbench-desktop/scripts/`, and runtime engine/device checks. Layer 1 (dev server, headless dev host, runtime API) proves everything that does not require the installed Windows shell; Layer 2 (the Desktop App) is reserved for what Layer 1 cannot prove (see [dev-host.md](../DECISIONS/dev-host.md)).

## Traps

- **Browser preview reload:** `capture-workbench-e2e:preview` (`apps/capture-workbench-e2e/src/fake-desktop.ts`) recreates its simulated runtime on reload; it cannot prove what the real host and a runtime that outlives a reload do.
- **Dev-host substitutes:** `capture-workbench-dev-host` runs the real Rust commands and library, but substitutes native file selection, WebView2, the native drop channel, and (with the fixture runtime) the engines.
- **Stale installed data:** `capture-workbench-e2e:smoke-real-engines-execution` never installs and fails on mismatched catalog-bound readiness or active model; worker-archive changes require a fresh `capture-workbench-e2e:smoke-real-engines-installation` on empty app data first.
- **Device, paths, and sensitive data:** Keep Windows install roots short. A registered OCR provider only shows availability; require observed execution on the selected adapter (`directml` or `cpu`). `capture-workbench-e2e:smoke-real-engines-execution` only enforces an exact OCR device when `CAPTURE_REAL_ENGINES_EXPECTED_OCR_DEVICE` is set; run `capture-workbench-desktop:check-real-engine-devices` when actual GPU/CPU execution sampling is required. Verify the device that ran against the design on every real-engine run. Keep private media, transcripts, user-profile paths, and bearer tokens out of evidence.

## Verification

- **Renderer timing, presentation, or new screen states:** Run `capture-workbench-e2e:preview` (`http://localhost:4300/__preview`) and add new states to `apps/capture-workbench-e2e/src/preview-scenarios.ts` instead of one-off scripts.
- **Real Rust commands, library persistence, and capture lifecycle across reload:** Run `capture-workbench-e2e:e2e-dev-host` for automated lifecycle evidence, or `capture-workbench-e2e:preview-dev-host` for manual inspection, against `capture-workbench-dev-host` and the deterministic fixture runtime; both depend on `capture-workbench-desktop:build-dev-host`.
- **Real-engine delivery (clean install, model install, restart verification):** Run `capture-workbench-e2e:smoke-real-engines-installation` on empty app data.
- **Real-engine execution and runtime API checks:** Run `capture-workbench-e2e:smoke-real-engines-execution` on matching installed app data (it runs the installed speech pack's default under the product launch policy). For runtime-API-only checks, run `capture-workbench-desktop:smoke-real-media` (stages the product runtime and proves PDF/image OCR and audio transcription) or `capture-workbench-desktop:smoke-real-ollama` (proves real-model structuring). For real-audio development checks outside the product launch policy, run `capture-workbench-desktop:check-real-engine-devices` with `--scenarios speech-development --audio <file>` after `capture-runtime:build-release-artifacts`: that scenario installs the `cuda` pack and sets `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini`, `CAPTURE_SPEECH_PREFER_GPU=true` and `CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK=false`, and checks provenance `tea-asr-1.1-mini` on `cuda` and the GPU it observed; release evidence uses the candidate's prescribed pack and fixture per [release-runbook.md](release-runbook.md).
- **Installed shell (WebView2, native dialogs or drop, installer, exit cleanup, pixel baselines):** Run the Desktop App only after Layer 1 passes; it requires a build and opens windows on the user's machine.
