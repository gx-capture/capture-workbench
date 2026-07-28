# GPU OCR with strict CPU fallback

## Scope

PDF and image OCR in `capture-runtime` use ONNX Runtime DirectML first on Windows. Audio
Whisper, Ollama, `CaptureEngineV1`, `/v1`, and the Angular package contract are unchanged.

## Provider policy

- `DmlExecutionProvider` is the GPU capability signal.
- When DML is registered, OCR creates one DML-first ONNX pipeline with
  `device_id=CAPTURE_WINDOWSML_DEVICE_ID`, sequential execution, and memory pattern disabled.
- When DML is not registered but `CPUExecutionProvider` is registered, OCR creates a CPU-only
  pipeline and reports a warning.
- When DML initialization or inference fails after DML is registered, the capture fails. It does
  not create or retry a CPU pipeline.
- If neither DML nor CPU is registered, the OCR requirement is unavailable.

## Adapter selection

The default DirectML adapter is index `0`, matching cert-prep's published-sidecar evidence for
`AMD Radeon(TM) 880M Graphics` (`amd_igpu`). The runtime does not auto-select a GPU by name and
does not route OCR through Whisper's CUDA device. Hosts may explicitly override the adapter with
`CAPTURE_WINDOWSML_DEVICE_ID`.

## User-visible provenance

`CaptureDocumentV1.extractionEngine.device` remains the existing field and reports
`windowsml-dml` or `cpu`. The desktop review surface displays this value beside the OCR engine
and model.
