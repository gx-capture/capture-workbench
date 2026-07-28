# Decision: DirectML-first OCR on the cert-prep iGPU route

## Decision

Use `onnxruntime-directml==1.24.4` for Windows OCR and Whisper's Windows extra. Remove the
generic `onnxruntime` dependency pulled by `faster-whisper==1.2.1` with a scoped uv dependency
exclusion so two distributions cannot overwrite the `onnxruntime` Python namespace.

OCR selects DirectML adapter `0` by default, preserving `CAPTURE_WINDOWSML_DEVICE_ID` as the
explicit override. This matches cert-prep's AMD Radeon 880M iGPU route without adding device-name
detection or automatic GPU selection.

## Consequences

The absence of `DmlExecutionProvider` is the only condition that permits CPU OCR. A registered
DML provider that cannot initialize or execute is an extraction error, making provider/driver
regressions visible instead of silently changing provenance. OCR provenance remains compatible:
`windowsml-ocr`, `windowsml-dml`, and `cpu` are retained.
