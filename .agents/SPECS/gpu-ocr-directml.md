# DirectML-first OCR without a CPU-only retry

## Scope

PDF and image OCR in `capture-runtime` use ONNX Runtime DirectML first on Windows. Audio
Whisper, Ollama, `CaptureEngine`, `/v2`, and the Angular package contract are unchanged.

## Provider policy

- `DmlExecutionProvider` is the GPU capability signal.
- When DML is registered, OCR creates one DML-first ONNX pipeline on the adapter chosen by
  `OcrComputePlan.select` (see below), with sequential execution and memory pattern disabled.
  `CPUExecutionProvider` remains the secondary provider in that same session so ONNX Runtime can
  execute kernels that DirectML does not support.
- CPU OCR is used only when no GPU is usable and policy permits it; readiness then carries an
  explicit CPU notice. CPU is never a recovery path after a selected GPU fails.
- When DML initialization or inference fails after DML is registered, the capture fails. It does
  not create or retry a separate CPU-only pipeline.
- If neither DML nor CPU is registered, the OCR requirement is unavailable.

## Adapter selection

The producer owns adapter selection. `capture_runtime/ocr_preflight.py:OcrComputePlan.select`
prefers a usable discrete GPU, then a usable integrated GPU, each with an exact LUID/ORT mapping,
as defined by the compute truth table in the
[Phase 2 SPEC](capture-runtime-042-p2-hardening.md#canonical-compute-decision-truth-table). An
indeterminate or incompletely mapped adapter is unavailable rather than guessed. Hosts never
select, rank, or persist an adapter ordinal; `CAPTURE_WINDOWSML_DEVICE_ID` is retired and the
runtime rejects it at startup. OCR never routes through Whisper's CUDA device.

## User-visible provenance

`CaptureDocument.extractionEngine.device` remains the existing field and reports
`windowsml-dml` or `cpu`. The desktop review surface displays this value beside the OCR engine
and model. `windowsml-dml` means the OCR session was configured DML-first; it does not claim that
every operator ran on the GPU because the same session retains the CPU execution provider.

## Production environment gate

The Windows production build must run `capture-runtime:prepare-production-environment` before
packaging. That target performs an exact uv sync and reinstalls `onnxruntime-directml`, because
switching from another ORT distribution can otherwise leave distribution metadata while removing
the shared `onnxruntime` package files. `capture-runtime:verify-production-environment` then
requires DirectML to be the only ORT distribution and namespace owner, with both
`DmlExecutionProvider` and `CPUExecutionProvider` registered. PyInstaller runs with
`uv run --no-sync` only after that gate succeeds. Release schema generation shares the same
prepare/verify dependency and also uses `--no-sync`, so it cannot race an ordinary environment
sync against production packaging.

## Verification evidence

The provider and production-environment rules were verified on 2026-07-29 on a Windows x64 host with `AMD Radeon(TM) 880M Graphics` and an NVIDIA
discrete adapter:

- The production environment gate reported `onnxruntime-directml` `1.24.4` as the sole
  `onnxruntime` distribution and import owner, with `DmlExecutionProvider` and
  `CPUExecutionProvider` registered.
- The adapter policy tests passed for DML-first selection, CPU-only mode when DML is absent,
  no separate CPU-only retry after a DML-session failure, and missing providers; the full runtime
  suite passed 74 tests.
- `capture-runtime:build-production-executable` passed after the environment gate.
- `capture-workbench-desktop:smoke-real-desktop-ocr-directml --skip-nx-cache` passed against an
  image-only one-page PDF. This DirectML-specific target always
  requires `windowsml-dml`; CPU provenance fails the gate. The packaged Tauri UI displayed
  non-empty raw OCR and structured output, and the isolated Ollama profile digest was preserved.
- The smoke deleted its library document, left the main library at its original seven entries,
  and left no desktop or runtime process.

Current PDF behavior always renders every page and reports `windowsml-ocr`.
The smoke therefore rejects embedded-text and composite extraction provenance.
