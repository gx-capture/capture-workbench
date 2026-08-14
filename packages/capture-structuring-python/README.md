# capture-structuring (Python)

The brain-agnostic Capture Workbench host SDK. Hosts supply the LLM callable;
the SDK owns bounded batching, prompt assembly, minimal semantic output
validation, trusted provenance reconstruction, and validation against the
private `CaptureDocument` schema bundled by `capture-runtime-client`.

The LLM must return only `sourceSegmentId`, `type`, and (for translation)
`targetText`. It must never echo `blockId`, `order`, `locator`, `sourceText`, or
any other provenance field. The host still submits the assembled candidate to
the runtime `POST /structure` endpoint before persisting it; the runtime is the
canonical validator.
