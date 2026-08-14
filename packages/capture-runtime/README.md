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
asset and fails when model, operation, problem, or route metadata drifts.

## Local verification

```powershell
uv run --python 3.12 python scripts/generate_contracts.py --check
uv run --python 3.12 pytest -q
```

The packaged executable includes both contract asset files under
`capture_runtime/assets` and performs a startup route-inventory drift check.
