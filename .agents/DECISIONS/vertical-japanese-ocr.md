# Vertical Japanese OCR decisions

2026-10-02 — user approved the staged implementation plan.

- Phase progression is automatic only after independent verification/review PASS;
  formal publication remains separate. A later phase cannot compensate for a failed gate.
- Keep Claude's three-phase architecture and geometric XY-cut starting point; retain
  Astra's domain/band/article ownership checks and per-article ruby output contract.
- Research scores are not full-product acceptance. The original cloud artifacts are
  unavailable; new local measurements have their own provenance and are not relabeled
  as reproductions of the missing cloud run.
- Phase 1 originally required an exact tuple permutation; the user-approved, separately
  gated composite exception below supersedes that universal restriction. Phase 2/3 change observations and are
  compared against image truth, not by requiring unchanged cross-inference source IDs.
- User selected per-page body/ruby CER non-regression with protected critical content
  and omissions; ordinary character error locations may change.
- User selected +150 MiB model storage, +512 MiB peak OCR RAM and <=2.5x warm triggered-
  page p95 relative to Phase 1, with no timeout relaxation.
- Change mode: mixed. Existing owner: capture-runtime. New owner needed: no. Add only
  focused benchmark/policy modules; replace misleading metric comparisons rather than
  adding another product pipeline. Verification floor: each phase's frozen gate.
- Approved test seams are in the spec; no new approval is required to implement them.

2026-10-02 — user approved adding Cert parser compatibility fixes to Phase 1 while
keeping strict gold and runtime tuple preservation. The frozen p2/p16 CPU and DML
probe returned zero questions on baseline and full-source oracle; image transcription
produced six/one questions but their last choice absorbed page number 2/16. These
failures cannot be fixed by horizontal identity or faithful tuple permutation alone.
The former scope conflict is resolved; consumer implementation and verification remain
open. The later explicit Phase 1 start below supersedes waiting for the Phase 0 gate.

2026-10-02 — user approved keeping Bunka p2 mandatory and adding limited cross-band
composite research/validation to Phase 1. CPU and DML source slot 21 combines upper
and middle first columns; slot 20 alone proves contradictory source-order constraints,
and 22 upper columns intervene in the image truth. Root and Astra independently
confirmed this. The original no-slicing rule is superseded only for this scoped repair,
conditional on validated automatic boundaries and text/polygon/score lineage. This
does not authorize hardcoding the observed offset 19, changing gold, removing Bunka,
starting Phase 2, general box slicing, rerecognition or changing the public box shape.
Ordinary boxes retain exact tuples. Split parent text must be conserved exactly once;
score aggregation and consumer behavior need explicit evidence. Research feasibility
and policy freeze remain open.

2026-10-02 — user explicitly directed: "請進入 phase1 實作並開始驗證。不要紙上談兵。"
Start Phase 1 product changes and tests now; do not wait for incomplete Phase 0
annotations or benchmark expansion. Phase 0 remains incomplete, not waived or passed.
Existing quality/contract requirements remain acceptance criteria, and later phases
still require their preceding acceptance/review. Preserve the current P0 annotation
work at resumable checkpoints and prioritize actual adapter integration, observable
reading-order improvement, horizontal identity and failure-path verification.

2026-10-02 — independent review identified holdout exposure after Root assigned the
former private image custodian as the product-policy author. Preserve those files,
but do not call them unseen for that author/policy. New unseen acceptance requires
fresh complete documents and a custodian who does not implement the policy. This
is an acceptance gap, not permission to stop the user-directed Phase 1 coding.

2026-10-02 — Astra independently reproduced the limited same-inference composite
research and permitted a bounded candidate implementation (review SHA256
`5e344a8bacd7a4830e917d13fe79050e340ac5cb964e20747149b64528164da9`).
This is not an adapter/phase approval. Before enabling a split, both children must
be nonblank, all nonblank CTC support must lie in real crop content rather than
padding, and child polygons must satisfy the existing wire shape and raster bounds.
The candidate also rejects reversed vertical axes and unsupported neighboring
domains. No gold text offset or second recognition call may select a boundary.

The candidate score policy keeps the existing output-box arithmetic mean. Each
child inherits its parent's original recognizer mean, explicitly not a calibrated
child confidence. The resulting increased weight of a split parent is disclosed;
the measured Bunka derived rounded mean changes from 0.9566 to 0.9567. The worker's
page confidence remains null; aggregation belongs to the downstream projection.
This choice
does not claim page-confidence identity or change the OCR profile/model.

Collector lifecycle policy: use hooks owned only by the selected pipeline instance,
restore them on every Python exit, retain no logits or crop arrays after collection,
and call each observed operation exactly once. Canonical collector attachment,
source-contract and execution failures follow the existing failed-job/provider-
cleanup path; they are not converted into a successful unsplit result. Insufficient
valid split evidence preserves the original parent and still fails any mandatory
case that requires splitting. Injected test pipelines can explicitly lack this
canonical seam. Original raw-slot plus half-open Python codepoint spans relative
to each strictly normalized parent string are private,
must reconstruct every parent once, and are never invented as new detector slots.

2026-10-05 — user: source PDFs are copyrighted and must not be uploaded. Test
fixtures built from real pages hold class-preserving placeholder text only; the
branch history was rewritten so no commit carries recognized source text. PDFs,
rasters and source-text copies stay in the ignored evidence folder.

2026-10-06 — user chose to stop the reading-order policy at candidate 09: "not
required to be 100% usable". Working scope is the JLPT kind of page (horizontal
with at most a boxed vertical passage, horizontal pages unchanged). Page structure
of dense periodical scans (page, band, heading and page-number order) is a recorded
limitation, not a Phase 1 task. This is a scope decision by the user; it does not
mark Phase 1 passed, does not waive the Cert, resource or gate-review requirements,
and does not start Phase 2. A redesign of page and band separation is the path if
periodicals become a requirement.

2026-10-06 — after the direction study the user stated the goal ("any vertical
Japanese document reads as fluent text", JLPT exam documents first) and chose
options 1 and 2 of the study to be done first. Consequences: (1) horizontal pages
are no longer byte-identical when they carry furigana: readings are whole regions
moved after the block of lines they annotate, nothing else on the page changes and
pages without furigana stay identical; this amends the Phase 1 rule "horizontal
pages retain their existing output exactly". (2) Routing vertical-dominant pages to
NDLOCR-Lite as a whole-page reader was only measured for feasibility; adopting it
would replace Phases 2 and 3 as specified and add a second engine, and needs the
user's separate decision. Neither item marks a phase passed.

2026-10-06 — user approved implementing the routing of vertical-dominant pages to
NDLOCR-Lite as a whole-page reader ("1 可做"). Decisions taken in the implementation:

- The reader's layout and reading-order sources are vendored from upstream commit
  `636d1cfe` (CC BY 4.0) with three import edits; detector and recognizer wrappers
  are rewritten in the runtime. No new dependency: the two networkx calls are
  replaced by a small module shown to return the same paths in the same order.
- The reader runs on the CPU provider only (its detector returns nothing on
  DirectML) and is used only for pages the routing rule selects; every page still
  gets the regular first pass, which supplies the routing signal.
- A routed page takes the reader's lines, order and recognition scores as whole
  regions. Composite splitting, the reading-order policy and region lineage do not
  apply to it. Mixed pages (share under 80%) stay with the regular pipeline.
- A reader that is installed but altered, or that fails in inference, fails the
  page. A page the reader cannot lay out, or reads with less than half the first
  pass's characters, keeps the first pass.
- The feature is inactive unless the reader's files are present beside the regular
  models. Delivering them (source lock approval, catalog, profile identity, public
  provenance of routed pages, attribution in the distribution) is a release-lane
  change that needs the user's separate approval; nothing in the released engine
  changes until then.
- Phases 2 (deskew retry) and 3 (second recognizer on single boxes) as specified
  are superseded by this route.

2026-10-06 — user approved reducing the cost of a routed page (both measures) and
asked for the reader to use the GPU where it can. Decisions in candidate 12:

- The three recognizers are delivered as derived files: upstream's models after
  ONNX Runtime 1.24.4 extended optimization on the CPU provider, loaded without
  further optimization. The derivation is byte-reproducible and scripted; the
  runtime pins the derived digests and the script pins upstream's.
- The detector stays upstream's file and always runs on the CPU provider: on
  DirectML its output is wrong on both adapters of the development machine, it
  takes 0.4 s on the CPU, and its derived form moves a few boxes by a pixel.
- The recognizers run on the DirectML device the regular pipeline selected, one
  line at a time, and on CPU threads when the regular pipeline runs on the CPU.
  A recognizer that DirectML does not accept fails the page; there is no separate
  CPU retry, as for the regular pipeline.
- The CPU memory arena is off for the reader's sessions.
- The DirectML execution evidence and proof of the regular pipeline do not cover
  the reader's sessions. That, and the public provenance of a routed page, stay
  open for the release lane.

2026-10-06 — user approved entering the delivery flow, pushing the branch, and
chose: derived recognizers are produced on the user's machine (not committed to
the repository and not redistributed), and the release is 0.5.0. Decisions taken:

- The engine delivers upstream's six NDLOCR-Lite files unchanged, as `source`
  entries of the model source lock from upstream's raw URLs at commit `636d1cfe`,
  with upstream's licence and README as licence and notice (SPDX CC-BY-4.0). The
  user's approval of these pinned sources in this conversation is recorded as the
  lock's approval time; the approver field keeps the existing identity.
- Each recognizer is optimized once per machine into the shared engine cache
  (entries named by SHA-256, accepted only with the pinned digest) and loaded
  from there. Cache off, unwritable, or other derived bytes: upstream's file is
  loaded, more slowly, with the same text. `CAPTURE_ENGINE_CACHE_DIR` reaches the
  OCR worker for this.
- The OCR profile (algorithm `capture-workbench-ocr-profile-v3`, schema 3)
  declares the reader: source, revision, licence, delivered files, derived
  recognizer digests, devices and the routing rule. Provenance stays per job:
  the profile identity covers the reader; `model`, `modelDigest` and `device`
  still describe the regular pipeline. No public contract field is added.
- Model-source snapshot for 0.5.0 is commit `8f37898ac6b3b51c0d4e1e44aa7ea53e693f6815`
  (tag `capture-runtime-model-sources-v0.5.0`).
- Publication (merge to `main`, candidate and promotion workflows, consumer
  migration of Cert Prep and LAW, consumer gates) follows the release runbook and
  is not started by this work.
