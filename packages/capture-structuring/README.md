# @gx-capture/capture-structuring

Brain-agnostic, provenance-safe host structuring SDK for Capture Workbench.
The host supplies the LLM callable; the SDK owns bounded batching, prompt
assembly, minimal semantic validation, and reconstruction of trusted block
provenance. The host must still submit the result to runtime `POST /structure`
before persisting it.

The LLM output is deliberately minimal: `sourceSegmentId`, `type`, and, for a
translated capture, `targetText`. Echoing `blockId`, `order`, `locator`,
`sourceText`, or other provenance is forbidden.
