# Decision: DirectML-first OCR

## Decision

Use `onnxruntime-directml==1.24.4` for Windows OCR and Whisper's Windows extra. Remove the
generic `onnxruntime` dependency pulled by `faster-whisper==1.2.1` with a scoped uv dependency
exclusion so two distributions cannot overwrite the `onnxruntime` Python namespace.

The producer selects the OCR adapter through `OcrComputePlan.select`: a usable discrete GPU, then
a usable integrated GPU, each with an exact LUID/ORT mapping (see the
[Phase 2 compute truth table](../SPECS/capture-runtime-042-p2-hardening.md#canonical-compute-decision-truth-table)).
Phase 2 replaced the original adapter-`0` default and the `CAPTURE_WINDOWSML_DEVICE_ID` host
override with this producer-owned selection; the runtime now rejects that variable.

Production environment preparation explicitly reinstalls `onnxruntime-directml` after uv's exact
sync. ORT distributions overwrite the same Python namespace, so an existing checkout can retain
DirectML distribution metadata while another ORT uninstall removes its import files. The
production build therefore verifies sole distribution ownership and registered providers, then
runs PyInstaller without another implicit sync. Release schema generation depends on the same
verified environment and also uses `uv run --no-sync`; no ordinary uv sync may run in parallel
with the production packaging chain.

## Consequences

CPU OCR is selected only when no GPU is usable and policy permits it, with an explicit notice in
the readiness result.
When DML is available, the single DML-first session still registers `CPUExecutionProvider` second
for unsupported kernels. A registered DML provider whose session cannot initialize or execute is
an extraction error; the runtime does not create a second CPU-only pipeline. This makes
provider/driver regressions visible without misrepresenting ONNX Runtime's per-kernel fallback.
OCR provenance remains compatible: `windowsml-ocr`, `windowsml-dml`, and `cpu` are retained, with
`windowsml-dml` meaning DML-first session configuration rather than an every-operator GPU claim.
