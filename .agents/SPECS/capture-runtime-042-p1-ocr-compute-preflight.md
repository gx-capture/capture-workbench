# Capture Runtime 0.4.2 P1 OCR compute preflight specification

## Outcome

The authenticated `GET /v2/health/ready` response includes a typed
`ocrCompute` decision owned by `capture-runtime`.  The decision is made before
OCR model/session creation and is the only runtime signal hosts use to choose
the OCR compute mode.

## Contract

`RuntimeReady.ocrCompute` is an additive `OcrComputePreflightV2` value with
`apiVersion: "2.0"`, `schemaVersion: "1"`, `runtimeVersion: "0.4.2"`,
`contractSetVersion: "2"`, and the exact authenticated contract-set digest.
Its stable decision fields are:

- `mode`: `gpu-dml` or `cpu-fallback`;
- `adapterClass`: `dedicated`, `integrated`, or `unknown`;
- `reasonCode`: `no_compatible_gpu`, `dml_provider_unavailable`, or `null`;
- `userNoticeRequired`: `true` only for CPU fallback; and
- `noticeCode`: `ocr_cpu_fallback` for CPU fallback, otherwise `null`; and
- `workerSha256`: the SHA-256 digest self-reported by the OCR worker
  executable, or `null` before the worker is installed.

After installation, the engine manager requires `workerSha256` to match the
catalog-bound worker archive's executable entry before exposing the decision.
This binds authenticated readiness to the exact worker that performed the
preflight rather than to a renderer or harness-side capability guess.

The model validates the relationship between mode, reason, and notice so a
caller cannot treat an inconsistent payload as a safe selection.

## Probe seam and policy

`OcrComputePreflight` is the deep decision module.  Its `OcrGpuCapabilityProbe`
seam accepts one capability snapshot containing hardware/software adapter
records and DirectML provider availability.  The production adapter uses
read-only native DXGI enumeration, a D3D12 architecture query, and
`onnxruntime.get_available_providers()`; it never shells out to WMI or
PowerShell.  An injected in-memory probe is used by unit and route tests.

Software-only DXGI adapters are excluded.  For a hardware adapter, the native
D3D12 `D3D12_FEATURE_DATA_ARCHITECTURE.UMA` property is the classification
evidence: `UMA=true` is `integrated` and `UMA=false` is `dedicated`.  A failed
or unavailable architecture query is `unknown` and therefore indeterminate;
it does not prove that the adapter is absent or unavailable. DXGI memory sizes
are not used as a substitute because WDDM may report nonzero dedicated memory
for UMA adapters. A lightweight provider availability probe is sufficient and
no OCR model is loaded.

### Canonical compute policy reference

The only CPU/GPU selection truth table is the reopened Phase 1 table in
`.agents/SPECS/capture-runtime-042-p2-hardening.md#canonical-compute-decision-truth-table`.
This preflight specification must conform to that table and must not define a
second policy. In summary, it selects a usable dGPU before a usable iGPU,
allows noticed CPU only for authoritative positive-unavailable/no-hardware or
authoritative provider-absent evidence, and never allows CPU for indeterminate
evidence or a post-selection DML failure.

This preflight only selects the allowed starting mode. If a DML-selected OCR
pipeline or session fails to initialize or infer, the existing WindowsML
adapter fails closed and never retries with another GPU or a separate CPU-only
session for that operation.

The packaged worker hashes its own executable during preflight. The core
runtime passes the catalog digest as an internal expectation and rejects a
mismatch or missing worker digest. The authenticated readiness response,
worker executable digest, and subsequent OCR provenance therefore form one
ordered identity chain for packaged acceptance.

## Verification and non-goals

Tests cross the probe/decision seam and the authenticated readiness route:
dGPU-first then iGPU selection, all-positive-unavailable hardware, authoritative
provider absence, inventory/provider indeterminate and structurally-invalid
snapshots, contract identity, and auth. Existing WindowsML tests continue to
prove DML session initialization or inference failure has no retry. A
read-only machine probe reports the current mode without loading PaddleOCR or
model assets. This slice does not update hand-written SDK clients, UI policy,
installed-package acceptance, real OCR, or release pointers; generated
contract artifacts are the only consumer impact handed to later workers.

Rollback is the parent checkpoint `888d0627bc23a3449e5e2173e351532b05e058e9`.
