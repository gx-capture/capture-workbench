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
