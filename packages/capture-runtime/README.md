# Capture Runtime v2

Capture Runtime is the authenticated, local Windows runtime for Capture
Workbench. The hard-cut release exposes only the v2 protocol; no compatibility
routes or legacy wire models are shipped.

## Public endpoints

All runtime endpoints require the configured Bearer token. Runtime readiness is
advertised at `GET /v2/health/ready`; streaming capabilities are advertised at
`GET /v2/streaming/health/ready`.
The capture lifecycle uses `/v2/ingestions` and `/v2/captures`; runtime
requirements, model options, and installations use `/v2/runtime/*`.

The immutable contract catalog is authenticated separately at
`GET /meta/v2/contracts`. The index points to a content-addressed bundle at
`/meta/v2/contracts/sha256/{sha256}`. Responses carry the bundle ETag, digest,
and `Cache-Control: public, max-age=31536000, immutable`. A mismatched digest
fails closed.

## Contract asset

`src/capture_runtime/assets/contract-set.json` is the canonical byte-stable
bundle. Its adjacent `contract-set.sha256` file contains the lowercase SHA-256
of those exact bytes. `scripts/generate_contracts.py --check` verifies the
asset and fails when model, operation, problem, or route metadata drifts. The
same generator renders the marked OCR v3 DTO/validator region in the Java SDK
directly from the `CaptureOcrProjectionV3` schema embedded in the canonical
contract-set bytes; hand-editing that Java region is therefore a contract
drift. There is no second Java OCR semantic digest.

## Local verification

```powershell
uv run --python 3.12 python scripts/generate_contracts.py --check
uv run --python 3.12 pytest -q
```

The packaged executable includes both contract asset files under
`capture_runtime/assets` and performs a startup route-inventory drift check.

## Speaker diarization worker

`capture-engine-diarization` is a separately packaged worker that answers "who
spoke when" for an audio or video file. It speaks the same JSON-lines worker
protocol as the OCR and Whisper workers, with requirement id
`speaker-diarization`.

It is not in the engine catalog, the v2 contract, or any release artifact yet:
the runtime does not start it, and no client can request it. Publishing it
needs an install unit, a model source and a contract shape for speaker labels.

- Model: a local pyannote `speaker-diarization-community-1` pipeline directory
  (`config.yaml`, `segmentation/`, `embedding/`, `plda/`). The worker runs
  offline and never reads a Hugging Face token.
- `run` returns `turns` (may overlap when people talk at once), `exclusiveTurns`
  (never overlap), `durationMs`, `provenance` and `warnings`. Times are
  milliseconds; speakers are anonymous labels such as `SPEAKER_00`.
- Options: `maxDurationMs`, `preferGpu`, `allowCpuFallback` and `numSpeakers`.
  A recognized CUDA failure retries the same model once on CPU.
- `capture_runtime.speaker_alignment.assign_speakers` gives timed transcript
  spans a speaker from those turns; a tie or an uncovered span stays unassigned.

```powershell
pnpm nx run capture-runtime:build-diarization-worker
```

The `diarization` dependency group installs CPU PyTorch. GPU diarization needs
a CUDA build of PyTorch in the worker environment.
