# Capture Runtime v2

Capture Runtime is the authenticated, local Windows runtime for Capture
Workbench. It exposes only the v2 protocol; no compatibility routes or legacy
wire models are shipped. The host installs each engine as a requirement
(install unit) through `/v2/runtime/*`; OCR, speech recognition and speaker
diarization run as separately packaged worker processes.

## OCR

The `capture-engine-ocr` worker serves requirement `windowsml-ocr`: PP-OCRv6
medium detection and recognition (Traditional Chinese multilingual dictionary)
on DirectML, or on the CPU when the compute plan selects it
(`src/capture_runtime/assets/ocr-profile.json`). The runtime orders the regions
of each page (`ocr_reading_order.py`), including furigana on horizontal pages
and boxed vertical passages.

The optional unit `vertical-japanese-reader` delivers the NDLOCR-Lite models
(no worker of its own; vendored layout code in
`src/capture_runtime/ocr/infrastructure/_vendor/ndlocr_lite/`). A vertical page whose text has
kana is read by it (`ocr_vertical_routing.py`, `ocr_vertical_reader.py`);
without the unit the page keeps the regular result and the capture names the
unit in `suggestedUnits`. See the
[decision record](../../.agents/DECISIONS/vertical-japanese-ocr.md).

Routing (`ocr_vertical_routing.py`): every page gets the regular first pass. A
page goes to the reader when the reading-order policy treats it as vertical, at
least three boxes are tall (height at least twice the width), at least 80% of
the recognized characters lie in tall boxes, and the page is Japanese (at least
5% kana; a first pass without kana and a character-weighted mean score of at
least 0.85 settles that it is not). A routed page takes the reader's lines,
order and scores as whole regions. Reader files that are altered, or a reader
that fails in inference, fail the page; a reader result with no text or under
half the first pass's characters keeps the first pass. Provenance (`model`,
`modelDigest`, `device`) still names the regular pipeline.

Known limits of the reading order and the reader:

- Pages that mix directions (vertical share under 80%) stay with the regular
  pipeline; no reader handles them well.
- Page structure of dense vertical periodical scans is not reliable: facing
  pages with a narrow gutter, page-tall rules, bands interrupted by a title or
  picture, detector boxes that span two bands, titles, authors and page numbers.
- About a fifth of furigana on textbook pages is not set aside; a reading over a
  line without ideographs stays in place, and furigana on the horizontal
  questions of a mixed page stays interleaved.
- Ruby on a routed page is whatever the reader returns, and its scores are not
  calibrated against the regular pipeline's.

`scripts/ocr_benchmark.py` (opt-in, uncached Nx `capture-runtime:ocr-benchmark`;
its tests are `capture-runtime:test-ocr-benchmark`) scores page layouts against
private local material; it is a research tool, not a release gate.

```powershell
pnpm nx run capture-runtime:build-ocr-worker
```

## Speech recognition

Speech recognition is requirement `speech-recognition`, which a release offers
as two packs (catalog contents). The `cuda` pack is the
`capture-engine-speech-recognition` worker on CUDA PyTorch with TEA-ASR 1.1 and
TEA-ASR 1.1 mini; TEA-ASR 1.1 runs on CUDA, and a classified CUDA failure retries
that same checkpoint once on CPU. The `cpu` pack is the
`capture-engine-speech-recognition-cpu` worker on CPU PyTorch with mini only; it
always runs on CPU. At install time `auto` takes `cuda` when
`%SystemRoot%\System32\nvcuda.dll` exists and `cpu` otherwise;
`CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda` or `cpu` forces a pack. The installed
pack is recorded and not re-detected later. Qwen3 forced alignment follows on the
same device in both packs. Models and processors load only from digest-verified
local directories. Recognition uses 30-second quiet-point chunks and bounded
retries for generation loops; results warn when a chunk still reaches its token
limit.

`CAPTURE_SPEECH_RECOGNITION_MODEL` chooses the recognizer. `auto`, the default,
runs the installed pack's model: TEA-ASR-1.1 on the `cuda` pack, including the
CPU retry, and TEA-ASR-1.1-mini on the `cpu` pack. `tea-asr-1.1-mini` runs on
either pack. `tea-asr-1.1` runs on the `cuda` pack on either device; on the `cpu`
pack the capture fails with `requirement_unavailable` before a worker starts.
On the `cuda` pack `CAPTURE_WHISPER_PREFER_GPU` (default `true`) still decides
whether CUDA is tried, and `CAPTURE_WHISPER_ALLOW_CPU_FALLBACK=false` turns the
retry off. Provenance names the model and device that produced the result.

A development test that transcribes real audio sets
`CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini` and disables CPU fallback,
then checks `tea-asr-1.1-mini` / `cuda`; see
[the research note](../../.agents/RESEARCH/tea-asr-1.1-mini-gpu-2026-11-04.md).
Release smokes and the private fixture stay on TEA-ASR 1.1 / CUDA and force the
`cuda` pack.

The `speech-recognition` extra uses Transformers 5.20.2 and the Windows cu128
build of PyTorch 2.11.0; speaker diarization uses CPU PyTorch. A worker archive
above 1.9 GB is published as ordered parts (`<archive>.001`, ...), each under
GitHub's 2 GB asset limit, and the installer joins and verifies them. See the
[decision record](../../.agents/DECISIONS/speech-recognition-tea-asr.md) for required
re-approval, private-output remeasurement and package-size checks.

Speech recognition and speaker diarization engine provenance records the result device, total processing time in `elapsedMs` (including any failed CUDA attempt and CPU retry), and the successful attempt's stage times in `stageMs`.

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
asset and fails when model, operation, problem, or route metadata drifts.

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
- `capture_runtime.diarization.infrastructure.speaker_alignment.assign_speakers` gives timed transcript
  spans a speaker from those turns; a tie or an uncovered span stays unassigned.

```powershell
pnpm nx run capture-runtime:build-diarization-worker
```

The `diarization` dependency group installs CPU PyTorch. GPU diarization needs
a CUDA build of PyTorch in the worker environment.
