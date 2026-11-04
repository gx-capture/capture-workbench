# DirectML-first OCR without a CPU-only retry

## Scope

PDF and image OCR in `capture-runtime` use ONNX Runtime DirectML first on Windows. Speech
recognition, Ollama, `CaptureEngine`, `/v2`, and the Angular package contract are not part of
this policy.

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

The local smoke `capture-workbench-desktop:smoke-real-desktop-ocr-directml` requires
`windowsml-dml` provenance; CPU provenance fails it.
