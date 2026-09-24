# Publication preflight decisions

2026-09-21. See the [SPEC](../SPECS/capture-runtime-042-publication-preflight.md).

- Change mode: edit existing publishers, candidate assembler and OCR error
  handling. Reuse existing identity/ledger owners; no parallel publisher or
  second candidate authority.
- Risk: critical for publication identity, high for private OCR diagnostics.
  Use independent specification and standards reviews of the bounded plan.
  The user's Astra-medium and minimum 30-minute analysis requirements override
  generic cheaper-model routing or short review timeouts.
- Root used grill-me to separate code-answerable questions from the open
  release-scope decision. Candidate layout, exact SDK-byte reuse and redacted
  error propagation can be resolved from source. Shipping current usable OCR
  versus all unfinished Phase2 features changes immutable version content and
  remains a user decision; common repairs can proceed independently.
- Manifest selection must follow actual package/runtime/full call paths and
  verified IDs/digests. A filename fallback alone is insufficient. Validate
  before the first irreversible upload; reuse the validated binding afterward.
- Python SDK distribution bytes have one build owner: the package candidate.
  Runtime candidate construction consumes those bytes after verification.
- Private error sentinels must not survive either log formatting or retained
  exception causes. Preserve existing semantic error categories and status.
- Latest OCR floor is actual usability, not full-text CER. Do not disguise
  anchor-only checks as zero CER, or mistake cached local assets/results for
  fresh published-package execution.
- Rollback before publication is an additive code correction or narrow revert;
  retain failed evidence. After any registry upload, reconcile and reuse exact
  bytes; never overwrite an immutable 0.4.2 artifact.
- Root verified no 0.4.2 occupancy in GitHub npm UI/client, GitHub Maven client
  and PyPI client. Producer analysis found none in crates.io or GitHub runtime
  releases. Recheck immediately before publication. The existing model-source
  tag is separate and must remain unchanged.

This is a proposed bounded repair plan, not a completed release gate or a
substitute for fresh review. Test/source evidence will be recorded in the TODO.

## Release scope decision (2026-09-24)

The user selected: publish 0.4.2 with printed-document OCR usability as the
floor and state handwritten recognition as a known limitation. Local
diagnostics found the canonical handwritten JPEG not practically usable with
the pinned PP-OCRv6 medium recognizer, with no integration defect proven.
Handwriting improvement is a separately scoped successor evaluation (likely a
dedicated recognizer and therefore a new immutable model identity), not a
0.4.2 blocker. Release notes must disclose the limitation; do not claim CER.

The user also approved committing the reviewed preflight repairs as two
slices and prioritising a Capture-first installed acceptance path. Capture's
production app data follows the Tauri identifier through Windows known
folders, so `APPDATA`/`LOCALAPPDATA` overrides do not isolate it. The
practical path therefore builds a side-by-side production installer whose
only configuration change is the identifier/productName/mainBinaryName
triple, proves the generated NSIS script cannot touch the ordinary
installation, and removes only run-owned state afterwards.

## Amendments after independent review

Both 30-minute reviews of `8b66098` reported BLOCKED. Root adopts their four
concrete corrections: include inline full-release PyPI and affected caller
inputs, reconcile remote bytes before upload, explicitly own production version
inventory repair, and correct the independently verified stale LAW expectation.
Keep Node 24 explicit and preserve existing Trusted Publishing action locations.
The SPEC now states identity rows, preflight/record modes, substitution checks,
remote retry/error cases and exact ownership. These are plan amendments only;
fresh workers must review them before implementation. Previous BLOCKED reports
are not converted into approvals.
