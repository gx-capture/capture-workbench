# GPU OCR DirectML closeout

- [ ] Run Python adapter tests for DML success, CPU-only fallback, strict DML failure, and missing
  providers.
- [ ] Run `uv sync --extra windowsml --extra whisper` and verify only DirectML ORT owns the Windows
  `onnxruntime` import and `DmlExecutionProvider` is available.
- [ ] Run capture-runtime Nx lint, typecheck, test, and production executable build.
- [ ] Run the explicit packaged desktop PDF OCR smoke when a user-provided PDF and prepared
  host-owned app-data directory are available; verify `extractionEngine.device` is
  `windowsml-dml` on the Radeon 880M route, or `cpu` with a warning when DML is unavailable.
