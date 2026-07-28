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

Production packaging installs the optional engines explicitly:

```powershell
uv sync --python 3.12 --extra windowsml --extra whisper
corepack pnpm nx run capture-runtime:build-production-executable
```

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
and `CaptureDocumentV1` schema published on the matching GitHub Release. The
executable binds only to loopback and every `/v1` request requires a Bearer
token.

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

The runtime still owns PDF/image extraction, WindowsML OCR, Whisper, upload
limits, retention, provenance, and final schema validation. External Ollama
only changes who owns structured generation. A host that owns all structuring
instead should use `CAPTURE_STRUCTURING_PROVIDER=host` and the `/raw` plus
`/structure` protocol described below.

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
- `CAPTURE_OLLAMA_MODEL=qwen3.5:4b`
- `CAPTURE_OLLAMA_PROFILE_ID=capture-workbench-qwen3.5-4b-structure-v1`

Run with `capture-runtime serve`. Production binds only `127.0.0.1` and disables API docs
unless explicitly enabled for development.

The deterministic extractor is deliberately opt-in. The standalone production extractor is
implemented in this package and has no imports from Cert Prep or another host: embedded PDF
pages use pypdf, scanned pages render through pypdfium2 and use WindowsML OCR, PNG/JPEG/WebP
are EXIF-corrected and normalized to RGB PNG before OCR, and supported audio uses local-only
faster-whisper models. Windows OCR uses DirectML when `DmlExecutionProvider` is registered and
falls back to CPU only when that provider is absent; a registered DML provider that fails during
initialization or inference is reported as an extraction failure. Whisper retains its separate
CUDA-resource CPU fallback.
Missing dependencies or model assets produce `requirement_unavailable`, never fake content.

Capture creation requires multipart fields `file`, `sourceKind=pdf|image|audio`, and optional
`structuringMode` / `targetLanguage`, plus a UUID `X-Idempotency-Key`. The runtime sniffs the
content and returns `422 source_kind_mismatch` when the declared kind disagrees. Uploads are
copied in bounded chunks to an app-data staging file and atomically moved into the new job;
terminal jobs delete the source bytes. Metadata and raw/result JSON expire after 24 hours by
default and are pruned on startup and during requests.

`GET /v1/runtime/requirements` uses stable requirement IDs. Ollama and the dedicated capture
profile are actively probed; a marker file alone never reports readiness. After a runtime
restart, a matching installation record causes requirement discovery to lazily start only the
owned isolated Ollama lifecycle and wait boundedly for the recorded profile to appear. The
synchronous installer contract runs off the API event loop. WindowsML installation uses the
runtime-release-owned URL, byte count, and SHA-256; it follows the release redirect while still
verifying the exact response bytes, then extracts exactly the six allowlisted ZIP entries with
traversal/ADS/symlink/expansion guards. The descriptor is
not configurable through the environment or exposed through desktop release metadata.
Whisper installation runs the two allowlisted Hugging Face model
downloads in a cancellable owned subprocess after `consent: true`; extraction never downloads.
Ollama installation also requires consent, uses `winget` only, and returns
`manual_action_required` when `winget` is absent.

When `CAPTURE_STRUCTURING_PROVIDER=host`, requirement discovery is scoped to
WindowsML and Whisper before probing begins. The process neither probes Ollama
nor advertises its application/model requirements, and both Ollama installation
IDs are rejected as disabled.

`build-release-artifacts` does not inspect or depend on ambient OCR/Whisper/Ollama model stores.
The tag release workflow verifies the synchronized version, package consumer smoke, runtime
tests, runtime artifact manifest/checksum, and package tarball before publishing the exact
candidate. It does not perform a separate clean-install evidence or attestation lane.

## Host structuring

Run the process with `CAPTURE_STRUCTURING_PROVIDER=host` when it is embedded by
a product that already owns an Ollama or another structured-output provider.
In this mode `/v1/health/ready` advertises only `structuringModes: ["host"]`
and `POST /v1/captures` rejects `structuringMode=runtime`; the sidecar therefore
cannot start its isolated Ollama through an accidental client request.

Create a capture with multipart field `structuringMode=host`. Poll until its stage is
`awaiting_structuring`, retrieve `/raw`, and submit a full candidate to `/structure`. Invalid
candidates return `422 invalid_structure` and terminate at `failed/structuring` while retaining
diagnostic raw. If the host provider fails before commit, post `{code, message}` to
`/structuring-failure`. Commit, failure, and cancel use one atomic terminal-state transition, so
concurrent requests cannot overwrite the winning result.

Provider implementations must honor their context and output budgets. Large
documents are handled as strictly validated ordered block batches and then
assembled with immutable raw provenance; malformed or provenance-changing
batch output fails rather than being truncated or repaired. The assembled full
document still passes the canonical runtime validator before completion.
