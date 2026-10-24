# Capture Runtime v2

Speech recognition and speaker diarization engine provenance records the result device, total processing time in `elapsedMs` (including any failed CUDA attempt and CPU retry), and the successful attempt's stage times in `stageMs`.

Speech recognition uses the separate `capture-engine-speech-recognition` worker
under requirement `speech-recognition`: TEA-ASR-1.1 on CUDA, TEA-ASR-1.1-mini on
CPU, and Qwen3 forced alignment after releasing the recognizer. Models and
processors load only from digest-verified local directories. Recognition uses
30-second quiet-point chunks and bounded retries for generation loops; results
warn when a chunk still reaches its token limit. One classified CUDA failure can
retry the mini model on CPU. The `speech-recognition` extra uses Transformers
5.20.2 and the Windows cu128 build of PyTorch 2.11.0. See the
[decision record](../../.agents/DECISIONS/speech-recognition-tea-asr.md) for required
re-approval, private-output remeasurement and package-size checks.

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
uv run --python 3.13 python scripts/generate_contracts.py --check
uv run --python 3.13 pytest -q
```

The packaged executable includes both contract asset files under
`capture_runtime/assets` and performs a startup route-inventory drift check.

## Speaker diarization worker

`capture-engine-diarization` is a separately packaged worker that answers "who
spoke when" for an audio or video file. It speaks the same JSON-lines worker
protocol as the OCR and TEA-ASR workers, with requirement id
`speaker-diarization`.

The optional install unit runs in its own process and supplies anonymous speaker
labels when a capture requests speaker identification.

- Model: NVIDIA `Nemotron-3-Diarization` under OpenMDW-1.1, using the native
  Transformers 5.20.2 implementation. The digest-verified local directory contains
  `config.json`, `processor_config.json` and `model.safetensors`. The worker loads
  with `local_files_only=True` and never reads a Hugging Face token.
  Regular turns retain overlapping activity above 0.5; exclusive turns select
  only the highest-scoring active speaker per 10 ms frame.
- `run` returns `turns` (may overlap when people talk at once), `exclusiveTurns`
  (never overlap), `durationMs`, `provenance` and `warnings`. Times are
  milliseconds; speakers are anonymous labels such as `SPEAKER_00`.
- Options: `maxDurationMs`, `preferGpu`, `allowCpuFallback`.
  A recognized CUDA failure retries the same model once on CPU.
- `capture_runtime.speaker_alignment.assign_speakers` gives timed transcript
  spans a speaker from those turns; a tie or an uncovered span stays unassigned.

```powershell
pnpm nx run capture-runtime:build-diarization-worker
```

The `diarization` dependency group installs CPU PyTorch. GPU diarization needs
a CUDA build of PyTorch in the worker environment.
