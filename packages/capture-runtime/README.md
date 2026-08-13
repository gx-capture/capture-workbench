# capture-runtime

Independent Python 3.12 FastAPI sidecar for Capture Workbench. It accepts one PDF, image,
or audio file per asynchronous capture job and emits provenance-bearing `RawCaptureV1` and
strictly validated `CaptureDocumentV1` JSON.

## Development

```powershell
uv sync --python 3.12
uv run pytest
uv run ruff check src tests
uv run mypy src
```

Production packaging builds the lightweight core and optional workers separately:

```powershell
corepack pnpm nx run capture-runtime:build-core-executable
corepack pnpm nx run capture-runtime:build-ocr-worker
corepack pnpm nx run capture-runtime:build-whisper-worker
corepack pnpm nx run capture-runtime:verify-core-boundary
corepack pnpm nx run capture-runtime:verify-worker-boundaries
```

The prepare target deliberately reinstalls `onnxruntime-directml`. The DirectML, generic, and
legacy WindowsML distributions share the `onnxruntime` Python namespace, so reinstalling the
selected distribution repairs an existing checkout when uv removes a previously selected ORT
distribution during an exact sync. Production execution uses `uv run --no-sync` only after this
gate verifies that DirectML is the sole namespace owner and both DML and CPU providers are
registered. That environment gate belongs to the optional worker builds; the
core executable has no ONNX Runtime, OCR, PDFium, Pillow, or Whisper dependency.

From the workspace root, use `corepack pnpm nx run capture-runtime:test` and the other declared Nx
targets.

To verify installation from a local release mirror instead of the workspace,
first stage `dist/release` and run:

```powershell
corepack pnpm nx run capture-runtime:local-release-consumer-smoke
```

This downloads the executable, checksum, manifest, and schema into an isolated
temporary consumer, validates their hashes, and checks authenticated sidecar
readiness. It does not publish remotely.

## Standalone Windows quick start

The public runtime artifact is the Windows x64 executable, checksum, manifest,
and `CaptureDocumentV1` schema published on the matching GitHub Release from
this repository. The canonical executable name is
`capture-runtime-x86_64-pc-windows-msvc.exe`; consumers must verify it against
`capture-runtime-manifest.json` before launching it. The executable binds only
to loopback and every `/v1` or `/v2` request requires a Bearer token. The
`capture-contracts`/`capture-structuring` wheels and
`capture-sidecar-launcher` crate are separate PyPI/crates.io artifacts and do
not replace the executable release.

For a host that already runs Ollama, configure the explicit external provider:

```powershell
$env:CAPTURE_API_TOKEN = 'replace-with-at-least-32-random-characters'
$env:CAPTURE_STRUCTURING_PROVIDER = 'external-ollama'
$env:CAPTURE_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434'
$env:CAPTURE_OLLAMA_MODEL = 'qwen3.5:4b'

.\capture-runtime-x86_64-pc-windows-msvc.exe serve --port 8766
```

Keep the API token and optional `CAPTURE_OLLAMA_API_KEY` in the process
environment. Never put either secret in an endpoint URL, browser storage, or
capture request. `external-ollama` does not start, install, or reuse a
runtime-owned Ollama model store; it checks the configured model at
`/api/tags` and calls `/api/generate` with bounded structured-output requests.

Check readiness from a backend or trusted local process:

```powershell
$headers = @{ Authorization = "Bearer $env:CAPTURE_API_TOKEN" }
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:8766/v1/health/ready' `
  -Headers $headers
```

Submit one source file and poll its asynchronous job:

```powershell
$job = curl.exe `
  -sS `
  -H "Authorization: Bearer $env:CAPTURE_API_TOKEN" `
  -H "X-Idempotency-Key: $([guid]::NewGuid())" `
  -F 'file=@sample.pdf' `
  -F 'sourceKind=pdf' `
  -F 'structuringMode=runtime' `
  http://127.0.0.1:8766/v1/captures | ConvertFrom-Json

do {
  Start-Sleep -Milliseconds 500
  $status = Invoke-RestMethod `
    -Uri "http://127.0.0.1:8766/v1/captures/$($job.captureId)" `
    -Headers $headers
} while ($status.status -in @('queued', 'running'))

$result = Invoke-RestMethod `
  -Uri "http://127.0.0.1:8766/v1/captures/$($job.captureId)/result" `
  -Headers $headers
```

The runtime core still owns embedded PDF text extraction, job lifecycle,
upload limits, retention, provenance validation, and final schema validation.
Installed runtime-owned workers handle scanned PDF/image OCR and audio
transcription. External Ollama only changes who owns structured generation. A
host that owns all structuring instead should use
`CAPTURE_STRUCTURING_PROVIDER=host` and the `/raw` plus `/structure` protocol
described below.

## Runtime configuration

The Tauri harness provides these environment variables. Secrets stay in the process
environment and Authorization header; they are never accepted in URLs.

- `CAPTURE_HOST=127.0.0.1`
- `CAPTURE_PORT`
- `CAPTURE_API_TOKEN` (at least 32 characters)
- `CAPTURE_ALLOWED_HOSTS=127.0.0.1:<CAPTURE_PORT>` (exact authority allowlist; a bare host,
  alternate port, or userinfo is rejected)
- `CAPTURE_ALLOWED_ORIGINS` (comma-separated exact browser Origin allowlist)
- `CAPTURE_ENABLE_API_DOCS=false`
- `CAPTURE_APP_DATA_DIR`, `CAPTURE_RETENTION_HOURS`, `CAPTURE_MAX_UPLOAD_BYTES`
- `CAPTURE_MAX_CANDIDATE_BYTES` (defaults to 8 MiB)
- `CAPTURE_STRUCTURING_PROVIDER=ollama|external-ollama|fake|host`
  (`external-ollama` requires `CAPTURE_OLLAMA_ENDPOINT` and optionally uses
  `CAPTURE_OLLAMA_API_KEY`; `host` disables runtime structuring and advertises
  only the host commit protocol)
- `CAPTURE_OLLAMA_MODELS_DIR=<capture-owned path>` (optional; ambient
  `OLLAMA_MODELS` is intentionally ignored so a host model store is never reused)
- `CAPTURE_EXTRACTION_PROVIDER=runtime|fake` (`runtime` is the production default)
- `CAPTURE_WINDOWSML_MODEL_DIR`, `CAPTURE_WINDOWSML_DEVICE_ID` (DirectML adapter index; defaults
  to `0`, the AMD Radeon 880M iGPU route used by cert-prep)
- `CAPTURE_WHISPER_MODELS_DIR`, `CAPTURE_WHISPER_PRIMARY_MODEL`,
  `CAPTURE_WHISPER_FALLBACK_MODEL`, `CAPTURE_WHISPER_PREFER_GPU`
- `CAPTURE_MAX_PDF_PAGES`, `CAPTURE_MAX_IMAGE_PIXELS`, `CAPTURE_OCR_RENDER_SCALE`,
  `CAPTURE_MAX_AUDIO_DURATION_MS`
- `CAPTURE_OLLAMA_HOST`, `CAPTURE_OLLAMA_APP_DATA`, `CAPTURE_OLLAMA_PID_FILE`
- `CAPTURE_OLLAMA_ENDPOINT`, `CAPTURE_OLLAMA_API_KEY` (external-ollama only)
- `OLLAMA_HOST`, `OLLAMA_MODELS`
- `CAPTURE_OLLAMA_MODEL` and `CAPTURE_OLLAMA_PROFILE_ID` are legacy/external
  compatibility settings only. A standalone Workbench launch does not set
  either value; it uses the additive model-options API so the user selects an
  allowlisted model and downloads it after consent.

Run with `capture-runtime serve`. Production binds only `127.0.0.1` and disables API docs
unless explicitly enabled for development.

The deterministic extractor is deliberately opt-in. The standalone production
core has no imports from Cert Prep or another host. Embedded PDF pages use
`pypdf`; scanned PDF/image work is sent through the installed OCR worker, which
owns PDFium, Pillow, Paddle, and ONNX Runtime DirectML. Audio is sent through
the installed faster-whisper worker. Windows OCR creates a DML-first session
when `DmlExecutionProvider` is registered, with `CPUExecutionProvider` second
for unsupported kernels. It selects a CPU-only pipeline only when DML is
absent; a registered DML session that fails during initialization or inference
is reported as an extraction failure instead of creating a second CPU-only
pipeline. `windowsml-dml` provenance therefore means DML-first session
configuration, not that every operator ran on the GPU. Whisper retains its
separate CUDA-resource CPU fallback. Missing workers or model assets produce
`requirement_unavailable`, never fake content or a runtime package download.

Capture creation requires multipart fields `file`, `sourceKind=pdf|image|audio`, and optional
`structuringMode` / `targetLanguage`, plus a UUID `X-Idempotency-Key`. The runtime sniffs the
content and returns `422 source_kind_mismatch` when the declared kind disagrees. Uploads are
copied in bounded chunks to an app-data staging file and atomically moved into the new job;
terminal jobs delete the source bytes. Metadata and raw/result JSON expire after 24 hours by
default and are pruned on startup and during requests.

`GET /v1/runtime/requirements` uses stable requirement IDs. OCR and Whisper
descriptors come only from the core-embedded, checksum-pinned engine catalog;
the renderer cannot supply a URL, checksum, command, or local path. Explicit
installation jobs stream and verify exact bytes, apply traversal/UNC/symlink/
collision/expansion/inner-manifest guards to worker archives, download the
catalog's immutable checksum-pinned model files into isolated staging, probe
the worker and model, and atomically activate a side-by-side version. Redirect
targets are validated before contact, and only explicitly allowlisted CDN
hosts may carry signed queries. A failed upgrade retains the previous
`active.json`; same-process residue is removed immediately, while validated
UUID staging/dot-temporary crash residue is removed under the requirement lock
at the next install without following reparse points or deleting final
versions. An installed version is reverified and works offline. No
installation or extraction path runs `pip`, `uv`, or mutable Hugging Face
client resolution. Ollama remains independent: it is actively probed, requires
consent for `winget` installation, and lazily starts only its owned isolated
profile after restart.

When `CAPTURE_STRUCTURING_PROVIDER=host`, requirement discovery is scoped to
WindowsML and Whisper before probing begins. The process neither probes Ollama
nor advertises its application/model requirements, and both Ollama installation
IDs are rejected as disabled.

`build-release-artifacts` does not inspect or depend on ambient
OCR/Whisper/Ollama model stores or accept ambient model-archive environment
variables. A publication build requires the canonical checked-in model source
lock to approve exact immutable URLs/revisions, destinations, owners,
licenses/NOTICE files, bytes, hashes, derivation provenance, and real fixture
expectations. The catalog embeds the resulting direct-file descriptors; only
worker ZIPs remain release assets.

Before a model-enabled tag, the local Windows machine runs the exact-SHA real
OCR/Whisper probes and Tauri/WebView three-media smoke against the canonical
source lock. The tag workflow then verifies main CI, rebuilds the lock-bound
catalog and worker archives, checks every checksum, the NSIS/package set for
the selected `release_mode`, installed size report, synchronized package
integrity, and exact remote release
asset-name set before publication. The package tarball is a GitHub Packages
artifact, never a GitHub Release asset. Model files and model ZIPs never enter
the GitHub Release.

## Streaming capture API (v2; OCR and audio)

The v2 API is an authenticated, resumable capture-upload protocol for PDF/image
OCR and audio extraction. It is intended
for a host backend or trusted local process; a browser or Web Component must
call the host backend rather than placing the sidecar token in browser code.
All paths below are relative to the runtime base URL, for example
`http://127.0.0.1:8766`. Send `Authorization: Bearer <token>` on every request.

Check support before using the protocol:

```http
GET /v2/health/ready
```

The response has `protocolVersion: "2"`, `captureKinds: ["pdf", "image",
"audio"]`, `supportsProgressiveAudio`, `maxChunkBytes`,
`checkpointIntervalMs`, `heartbeatIntervalMs`, and `stallTimeoutMs`. When
`supportsProgressiveAudio` is `false`, the runtime remains ready for PDF/image
OCR; audio clients must select another runtime or a host-owned audio path.

The client flow is:

1. Open an ingestion with `POST /v2/ingestions`.
2. Start a capture with `POST /v2/captures` using the returned `ingestionId`.
3. Upload contiguous, zero-based chunks with `PUT /v2/ingestions/{ingestionId}/chunks/{chunkIndex}`.
4. Finalize the ingestion with `POST /v2/ingestions/{ingestionId}/finalize`.
5. Read `GET /v2/captures/{captureId}/events` as a live Server-Sent Events
   stream; it ends at a terminal state or host-owned `awaiting_structuring`
   handoff.
6. Read `/partial` for the latest progressive projection, then call `/structure`
   for a runtime-owned structuring provider, or use the host candidate commit /
   failure routes for `structuringMode: "host"` before reading `/result`.

Open an ingestion with a stable client request id and the complete source
metadata. `kind` selects `pdf`, `image`, or `audio`; `mode` is currently
`file`:

```json
{
  "protocolVersion": "2",
  "kind": "audio",
  "mode": "file",
  "clientRequestId": "host-audio-001",
  "fileName": "lecture.mp3",
  "mediaType": "audio/mpeg",
  "totalBytes": 1234567,
  "sourceSha256": "<64 lowercase hex characters>"
}
```

Upload each chunk with a matching byte range and SHA-256 digest. Chunks must
start at the current `nextOffset`; retries of the same byte range are
idempotent. The `Content-Range` total must equal the value used when opening
the ingestion, and the body must not exceed `maxChunkBytes`.

```http
PUT /v2/ingestions/<ingestionId>/chunks/0
Content-Range: bytes 0-1048575/1234567
Digest: sha-256=<64 lowercase hex characters>
X-Idempotency-Key: host-audio-001-chunk-0
Content-Type: application/octet-stream
```

Finalize only after all bytes have been accepted:

```json
{
  "protocolVersion": "2",
  "totalBytes": 1234567,
  "sha256": "<64 lowercase hex characters>"
}
```

Start the capture with `structuringMode: "runtime"` for the runtime-owned v2
structure flow below. A host-owned provider may start v2 extraction with
`"host"`; after the operation reaches `awaiting_structuring`, commit a full
validated `CaptureDocumentV1` candidate to
`POST /v2/captures/{captureId}/structure/commit`, or report failure to
`POST /v2/captures/{captureId}/structure/failure`:

```json
{
  "protocolVersion": "2",
  "clientRequestId": "host-audio-capture-001",
  "ingestionId": "<ingestionId>",
  "structuringMode": "runtime",
  "targetLanguage": "zh-TW",
  "startPolicy": "eager"
}
```

The SSE endpoint returns `Content-Type: text/event-stream`, replays durable
records after `Last-Event-ID`, and remains open while extraction or runtime
structuring is active. It emits SSE comment heartbeats during quiet periods and
ends only at a terminal state or host-owned `awaiting_structuring` handoff.
Records have this shape:

```text
id: 12
event: segment
data: {"protocolVersion":"2","eventId":"<captureId>/12","sequence":12,"captureId":"<captureId>","eventType":"segment","stage":"extracting","partialRevision":3,"coveredUntilMs":300000,"segments":[...],"createdAt":"<RFC3339 timestamp>"}

```

The `id` is the durable integer event sequence. Reconnect with
`Last-Event-ID: 12`; the runtime returns only events after that sequence. Event
types are `accepted`, `input_checkpoint`, `heartbeat`, `segment`, `checkpoint`,
`resync_required`, `completed`, `failed`, and `cancelled`. A
`resync_required` event means the replay window was exceeded; fetch the current
capture operation and `/partial` (or `/result` when terminal) before resuming
UI state. Never treat a missing heartbeat as a successful completion.

The operation endpoint is `GET /v2/captures/{captureId}`. It includes the
source `kind` copied from the finalized ingestion (`pdf`, `image`, or
`audio`). Its status is one of
`created`, `waiting_input`, `extracting`, `awaiting_structuring`, `structuring`,
`completed`, `failed`, or `cancelled`; it also reports `partialRevision` and
`lastEventSequence`. The remaining endpoints are:

| Endpoint | Purpose | Success |
| --- | --- | --- |
| `GET /v2/ingestions/{id}` | Read upload progress and `nextOffset` | `200` |
| `DELETE /v2/ingestions/{id}` | Remove an unused ingestion | `204` |
| `GET /v2/captures/{id}/partial` | Read the latest validated partial raw projection | `200` |
| `POST /v2/captures/{id}/structure` | Run the configured runtime-owned structurer | `200`, `CaptureDocumentV1` |
| `POST /v2/captures/{id}/structure/commit` | Commit a host-owned validated candidate with `X-Idempotency-Key` | `200`, operation |
| `POST /v2/captures/{id}/structure/failure` | Atomically fail host-owned structuring with `{ protocolVersion: "2", code, message }` and `X-Idempotency-Key` | `200`, operation |
| `GET /v2/captures/{id}/result` | Read the terminal structured result | `200`, `CaptureDocumentV1` |
| `POST /v2/captures/{id}/cancel` | Request cancellation | `200`, operation |
| `DELETE /v2/captures/{id}` | Delete ephemeral capture state | `204` |

Common protocol errors are `409 chunk_out_of_order`,
`409 chunk_checksum_mismatch`, `409 invalid_capture_state`,
`409 partial_unavailable`/`result_unavailable`, `422 invalid_event_cursor`,
and `404 capture_not_found`/`ingestion_not_found`. Error bodies use the same
`{"error":{"code":"...","message":"..."}}` envelope as the v1 API.
Runtime capture state is ephemeral; the host owns durable source and document
persistence and should save only validated terminal output.

## Host structuring

Run the process with `CAPTURE_STRUCTURING_PROVIDER=host` when it is embedded by
a product that already owns an Ollama or another structured-output provider.
In this mode `/v1/health/ready` advertises only `structuringModes: ["host"]`
and `POST /v1/captures` rejects `structuringMode=runtime`; the sidecar therefore
cannot start its isolated Ollama through an accidental client request.

Create a capture with multipart field `structuringMode=host`. Poll or consume the
authenticated SSE stream until its stage is `awaiting_structuring`, retrieve
`/partial` or the terminal raw projection, and submit a full candidate to
`/structure/commit` with `X-Idempotency-Key`. Invalid candidates return
`422 invalid_structure` and terminate at `failed/structuring` while retaining
diagnostic raw. If the host provider fails before commit, post
`{ protocolVersion: "2", code, message }` to `/structure/failure` with a
stable `X-Idempotency-Key`.
Commit, failure, and cancel use one atomic terminal-state transition, so
concurrent requests cannot overwrite the winning result. The v1 `/raw`,
`/structure`, and `/structuring-failure` routes remain available for existing
v1 host clients; they are not the v2 consumer boundary.

Provider implementations must honor their context and output budgets. Large
documents are handled as strictly validated ordered block batches and then
assembled with immutable raw provenance; malformed or provenance-changing
batch output fails rather than being truncated or repaired. The assembled full
document still passes the canonical runtime validator before completion.
