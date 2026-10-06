# Vertical Japanese OCR — approved staged implementation

Approved 2026-10-02. Source baseline: `648d042b11f663a7c4932f97caf13adccbd22004`.
This is the user's approved phased plan, reconciled with the
[verification findings](../RESEARCH/opus55-vertical-japanese-verification-2026-10-01.md).
The desktop Claude patch is reference material, not an instruction to apply it wholesale.

## Ownership and contract

Capture Runtime continues to own rasterization, inference, normalization and ordering.
Public page/box fields do not change. Phase 1 normally permutes complete, validated,
nonempty regions without changing text, polygon or score. The user-approved limited
cross-band composite exception below requires separate research and validation before
any product implementation; it is not a blanket permission to slice boxes. One plan produces page text, boxes and
region confidences. Each article emits label/title, body, signature, then its own ruby
run separated by blank lines. Horizontal pages retain their existing output exactly.
Private source IDs preserve observation identity and original result/region slots.

## Sequential gates

2026-10-02 user steering: **start Phase 1 product implementation and verification
immediately**. This supersedes waiting for Phase 0 acceptance before starting Phase 1.
Unfinished Phase 0 evidence stays open and is not relabeled PASS. Phase 1 acceptance
requirements, later-phase gates and separate publication approval remain unchanged.

Except for the explicit Phase 1 start above, no work implementing the next phase starts
before the current phase's evidence and independent GPT-6 Astra Ultra review pass.
Failing gates remain open; later gains cannot
offset an earlier failure. Publication is a separate decision. No phase is passed by
editing this document or a checklist: checks validate evidence and behavior.

1. **Phase 0 — trustworthy baseline.** Prepare a common research runner and evaluator;
   freeze four specified N1 documents, the retained 53-page corpus and required layout
   examples, including a genuine same-column body fragment. Obtain independent image
   transcription and cross-review, with role/article/order/owner annotations and explicit
   missing/composite observations. Freeze at least two unseen full documents separately
   for Phases 1, 2 and 3A. Keep their content with an independent custodian until the
   corresponding policy is frozen. Record canonical CPU/DML baseline and resources.
   The evaluator must detect deliberate omission, duplication, order, owner, article
   and format errors. Cloud CER values are historical reports, not required goldens.
2. **Phase 1 — reading order with a gated composite exception.** Standard-library `ocr_reading_order.py`
   runs after strict normalization. Analyze deskewed coordinates without rotating the
   raster or modifying polygons; use local scales and region-aware XY-cut. Resolve page
   domains/bands before columns/articles, then labels, short columns, signatures and
   ruby ownership. Cross-band long boxes cannot merge body bands. Kana is supporting
   evidence, not a mandatory ruby classifier. Preserve the initial fewer-than-two-long-
   columns and 1000-region guards; guarded required cases still fail acceptance.
   No general slicing, rerecognition, extra model, profile switch or weighted search. Required
   mixed cases, two full holdouts, consumer parsing/round-trip, fresh CPU/DML inference
   and packaged validation all must pass before Phase 2.
   User-approved addition on 2026-10-02: Phase 1 also owns narrowly scoped Cert parser
   compatibility fixes required by the frozen gold (including missing first-option
   markers, page-number contamination, visible question-number punctuation and
   continuation-page/cross-page option boundaries demonstrated by the frozen corpus).
   Cert must not repair runtime strings/tuples;
   strict semantic gold is not weakened. The later explicit Phase 1 start also
   authorizes this consumer work now; incomplete Phase 0 evidence remains open.
   User-approved addition on 2026-10-02: retain mandatory Bunka p2 and research limited
   repair of source boxes that merge body text across separate bands. Its frozen source
   slot 21 contains two first columns with 22 other upper-band columns required between
   them; no whole-box permutation can satisfy the image order. Before implementation,
   independently validate automatic split eligibility, text boundaries, child geometry
   and score provenance without gold-derived runtime boundaries. Unsplit tuples remain
   exact; child spans must partition the parent string once, without loss, duplication,
   rewriting or reversal. Parent/child and coordinate lineage stays internal. Validate
   page confidence aggregation, box/confidence alignment, source coverage and Cert/LAW
   readback separately; copied parent scores are not independently calibrated child
   confidence. Keep horizontal identity and all mandatory gold. Approval resolves the
   scope decision, not algorithm feasibility or any phase gate. The policy and required
   evidence must be frozen after this research, before product implementation.
3. **Phase 2 — raster deskew and one retry.** Initial policy: at least three reliable
   long boxes, consistency >= 0.6, 1 <= abs(skew degrees) <= 5, on vertical or mixed
   pages only. Expand the Pillow canvas with white fill; predict once more and use that
   validated result. Do not choose using gold/CER or swallow a second-predict failure.
   Analyze in the chosen raster frame and map polygons back, testing unclamped geometric
   round trips and edge preservation. Update profile deskew declaration and provenance.
   Require improvement on predefined skew targets, no per-page quality regression,
   new full holdouts, consumer regression and resource acceptance.
4. **Phase 3A — NDLOCR-Lite evaluation.** No product behavior change. Pin the supplied
   NDLOCR-Lite commit, three models, charset, digests and licenses. Compare Phase 2,
   same-crop PP, NDL CPU and NDL DML. Start with long-axis crops, model ratios 22/40,
   output-length escalation 25/45 and geometric-mean confidence 0.7. Never route empty
   PP boxes; preserve horizontal output. Valid empty/low-confidence/truncated outputs
   keep the original PP tuple; malformed outputs and execution failures do not.
   All sessions need execution evidence; 99% matching CPU/DML strings alone is not a
   gate. Freeze the exact passing policy on new holdouts before integration.
5. **Phase 3B — integrate only the frozen policy.** Recognize in the final chosen raster
   frame before final role/order assembly. Accepted NDL text receives its NDL confidence;
   rejected valid results retain PP text and score together. Upgrade the canonical OCR
   profile to v3 and update model sources, licensing, catalog and execution evidence.
   Rerun the full integrated behavior, quality, resources, cancellation and installed
   consumer journey. Any policy change returns to 3A.

## Quality, measurement and evidence

- Pure-order comparisons keep the same complete source-ID multiset. Any limited
  composite repair requires a separately validated parent/span conservation check and
  cannot be labeled a pure-order result. Do not duplicate parent IDs or weaken the
  existing whole-region evaluator to make a split result pass. Recognition CER
  uses independently assigned GT roles and fixed denominators; candidate ruby removal
  must not improve the denominator. Report body/ruby/full-text, false roles, owners,
  article/band errors, omissions, duplicates and exact formatting separately.
- Phase 2/3: each page's body and ruby CER must not increase from the previous phase;
  at least one improves on each predefined target. Question IDs, choices, grouping and
  omissions cannot acquire new errors. Ordinary character error locations may change.
- Additional model files <= 150 MiB; OCR-process peak RAM increment <= 512 MiB relative
  to Phase 1; triggered-page warm p95 latency <= 2.5 times Phase 1. Existing timeouts
  remain. Measure the whole path, all sessions co-resident, same hardware/provider/pages,
  two warmups and twenty timed runs per representative page. Record cold startup too.
- Preserve source snapshot, policy/profile/model/input digests, complete page results
  and independent review. Exposed holdouts become regression inputs; policy changes
  informed by failures require new unseen complete documents.
- Tests use Nx. Unit/integration, lint/typecheck, semantic replay, real CPU/DML,
  packaged worker and Cert/LAW consumption are distinct evidence tiers. No staging,
  commit, push or publication is implied by passing a local phase.

## Current state

Phase 1 implementation was started by the user's explicit 2026-10-02 instruction
with Phase 0 incomplete and closed on 2026-10-06 at reading-order candidate 09. Its
working scope, by the user's decision, is horizontal pages with at most a boxed
vertical passage; page structure of dense periodical scans is a recorded limitation.
Phase 1 is not marked passed: strict Cert semantics are not met and no gate review
was held. Phase 2 and 3 behavior is not implemented; Phase 2 preparation (resource
reference, trigger-page inventory, open design questions) is recorded in the Phase 2
preparation note. Status per requirement, source hashes and limitations are in the
Phase 1 research note.
