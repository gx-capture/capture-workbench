# Decision: runtime-owned OCR compute preflight

## Chosen design

Extend the existing authenticated `/v2/health/ready` contract with an
additive, typed `ocrCompute` field.  This keeps the decision on the existing
capabilities/readiness handshake and avoids hosts independently inspecting GPU
state.

`OcrComputePreflight` owns the decision.  Its injectable capability probe
combines native, read-only DXGI adapter enumeration, a D3D12 architecture
query, and ORT's registered provider list.  DXGI software adapters are
ignored; hardware classification uses only the native UMA property.  DXGI
memory sizes are intentionally not used because WDDM can report nonzero
dedicated memory for an integrated UMA adapter.

## Canonical compute policy reference

The only CPU/GPU selection truth table is maintained in the reopened Phase 1
design at
`.agents/SPECS/capture-runtime-042-p2-hardening.md#canonical-compute-decision-truth-table`.
This decision records the rationale and invariants; it must not introduce a
second policy. In that table, `positive-usable` means a proven non-software
dGPU or iGPU with a known class, unambiguous identity mapping, registered
`DmlExecutionProvider`, and a successful adapter capability probe. The automatic
order is dGPU, then iGPU, then noticed CPU only after a CPU-allowed row is
complete.

## Invariants

1. CPU fallback is legal only for the two CPU-allowed rows in the canonical
   truth table and always requires `userNoticeRequired: true` and
   `noticeCode: "ocr_cpu_fallback"`.
2. Hardware with a registered DML provider selects a usable dedicated adapter
   before a usable integrated adapter; CPU is not an alternative to a usable
   GPU.
3. A proven hardware adapter with an authoritative provider query that omits
   `DmlExecutionProvider` is an explicit CPU fallback with
   `dml_provider_unavailable`; this is not a post-selection failure.
4. Indeterminate or structurally invalid evidence yields readiness unavailable,
   never a CPU fallback or CPU notice.
5. The preflight does not alter WindowsML pipeline behavior. A DML-selected
   pipeline/session initialization or inference error remains fail-closed with
   no other-GPU or CPU-only retry for that operation.
6. Every preflight payload carries API, schema, runtime, contract-set version,
   and the exact authenticated contract-set digest.
7. An installed worker self-reports its executable SHA-256 during preflight;
   the engine manager accepts the decision only when that digest matches the
   catalog-bound worker artifact identity. Missing or mismatched identity is
   unavailable, never a CPU fallback.

## Rejected alternatives

- Host-side WMI/PowerShell detection: duplicates policy and leaks a platform
  seam outside the runtime.
- Provider-list-only detection: cannot exclude software-only adapters or
  safely classify dedicated versus integrated hardware.
- Model OCR as preflight: expensive, unnecessary, and unsafe for readiness.
- A second preflight route: the authenticated readiness contract already
  exists and is negotiated by clients.

## Rollback

Revert this focused slice to `888d0627bc23a3449e5e2173e351532b05e058e9`; leave
the known line-ending-only desktop schema status untouched.
