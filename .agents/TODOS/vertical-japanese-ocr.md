# Vertical Japanese OCR execution ledger

See [approved spec](../SPECS/vertical-japanese-ocr.md). Checks here track work only;
phase PASS requires actual, source-bound evidence and independent Astra Ultra review.
Current evidence: [Phase 0 implementation record](../RESEARCH/vertical-japanese-ocr-phase0-implementation-2026-10-02.md).

## Phase 0 — incomplete; no longer blocks the user-directed Phase 1 start

- [x] Persist approved specification and decisions; preserve existing research changes.
- [ ] Implement evaluator and adversarial behavior tests (source IDs, tuples, order,
  roles, owners, article membership, exact text and independently partitioned CER).
  Verify: `corepack pnpm nx run capture-runtime:test-ocr-benchmark --skip-nx-cache`.
  Progress: 77 behavior cases pass, including explicit allowed orders, material-copy
  integrity failures and whole-source order infeasibility diagnostics; four Astra
  evidence-reliability findings fixed and independently rechecked. Latest allowed-order,
  resource protocol and 2025 source binding increment reviewed. Full-corpus coverage open.
- [ ] Freeze source manifests, regression rasters and independent holdout reservations.
  Verify: benchmark inventory checks hashes, duplicates and complete document coverage.
  Progress: 176 development rasters frozen; all 53 retained raster hashes match; six
  holdout documents reserved with independent bounded completeness/deduplication evidence.
  Subsequent F3 review invalidated their unseen status when their reader became the
  policy author. They remain retained evidence; fresh unseen documents are still needed.
- [ ] Complete independent image transcription and cross-review for every required case;
  identify a genuine same-column body-fragment positive and record composite/missing text.
  Verify: annotation and binding completeness report, with no unresolved required pages.
  Progress: Bunka's 108 columns cross-reviewed with one unresolved citation glyph;
  p14, 2023 p16 and 2025 p16 have independently checked source mappings. The 2023
  missing option marker is an unrepresented image span, not a proven recognition
  omission. Bunka has a confirmed cross-band atomic-box order contradiction.
  The supplied 2025 document now has 46/46 image pages cross-reviewed (1,055 blocks),
  and 2024-12 has 27/27 (704 blocks); full source bindings remain open. Both Phase 1
  private documents have two readers; same-source higher-resolution adjudication closed
  one document's final glyph, while the other still has one unresolved glyph. The bounded
  1277 search reviewed 475 pairs without finding the required positive. Additional
  MEXT 2019-07 development material supplies seven independently verified same-column
  body-list trailing-token positives. CPU/DML bindings cover their 14 fragments; the
  v2 verifier independently closes sourceDigest, image and normalized/raw tuple checks.
  Both containing pages have complete first drafts; p14 second reading found no literal
  errors and one footer-role proposal, while p15 second reading is active. Complete
  semantic gold remains open and broader fragment subtypes are not claimed.
  2023 now has all 50 supplied image pages cross-reviewed (1,214 blocks, 305 ruby,
  66 four-option questions, no dangling owners), retaining its p37 blind pixel-equivalent
  review and separate footer adjudications. Full OCR source bindings remain open.
  2024-07 has 42 further first-reader pages (1,117 blocks), with 28 unresolved clipped
  sidebars and second review still open; prior p2/p16 are retained. The prior automatic
  approval quota failure was resolved by retrying the original escalation path; these
  exports actually ran twice through Nx with identical results. No phase gate passed.
  The July second reader has sealed 20/42 additional pages; image-confirmed corrections
  are stored separately from immutable first drafts. Both P3A full documents now have
  first/second readings, adjudications and exact-delta confirmation; this is opaque
  custody evidence, not policy acceptance. Extra P1 second reading is active.
- [ ] Run canonical fresh CPU/DML baseline and resource collection through the common runner.
  Verify: noncached benchmark evidence with profile/model/input digests and DML node proof.
  Progress: fresh 176-page CPU and DML inference completed, plus repaired-runner DML
  smoke checks and 24 synthetic variants on each provider. Fixed three-page resource-02
  measurements completed, each with exactly two warmups and twenty timed samples.
  A further real WorkerClient/PDF-worker 2+20 run completed for CPU/DML. Independent
  review blocked its complete-tree RAM claims; v5 adds lifetime Job accounting,
  native-exit checks and artifact integrity. DML 66 jobs and CPU three smoke pages passed;
  v6 fixes two further cleanup-error findings and passes 39 independent fault mocks.
  Same-version v6 CPU/DML 66+66 jobs are now independently hash-verified (review 04).
  Local source-worker artifact review passed, with final monitor-drain timing and null
  runtime-bound execution-proof limitations explicit. Phase/product resource acceptance
  is not established; the broader Phase 0 gate remains open.
- [ ] Freeze Phase 0 evidence and obtain Astra Ultra independent gate review.

## Phase 1 — implementation closed 2026-10-06, not marked passed

Started by explicit user steering on 2026-10-02 with Phase 0 incomplete. Status per
requirement is in the
[closing section](../RESEARCH/vertical-japanese-ocr-phase1-implementation-2026-10-02.md#2026-10-06--phase-1-closing-status)
of the Phase 1 record.

- [x] Complete user-approved limited cross-band composite feasibility research and
  independent review; freeze automatic split eligibility, text/geometry/score lineage
  and parent conservation gates before product implementation. Bunka remains mandatory.
- [x] Implement and test the pure reading-order policy and adapter assembly.
  Stopped at candidate 09 by user decision on 2026-10-06
  ([decisions](../DECISIONS/vertical-japanese-ocr.md)). Working scope: horizontal
  pages with at most a boxed vertical passage. Page structure of dense periodical
  scans is a recorded limitation; the complete list is in the Phase 1 record.
- [x] Pass exact unsplit tuple preservation, split conservation and horizontal
  identity on fresh CPU/DML, the local package journey and LAW readback (393 boxes),
  and on 927 supplied horizontal pages.
- [ ] Pass required mixed layouts. Met for the JLPT kind and the rendered set; for
  Bunka-type periodicals only column order holds. Accepted as a limitation by the
  user; complete Bunka and MEXT page gold was never finished.
- [ ] Implement user-approved Cert parser compatibility fixes against strict image
  gold. Open in the Cert repository (uncommitted parser changes there). Measured on
  candidate 09: 4 of 11 questions on six in-scope pages parse, each of them complete;
  the rest fail on option markers the detector splits off or drops, and Cert does
  not attach the vertical passage to its question. Reading order does not change
  the outcome.
- [ ] Independent gate review of Phase 1 against the 2026-10-06 scope. Five bounded
  reviews exist; none is a phase gate.

## Phase 2 — locked by Phase 1; preparation done 2026-10-06

See the [Phase 2 preparation](../RESEARCH/vertical-japanese-ocr-phase2-preparation-2026-10-06.md).
Opening implementation is the user's decision.

- [x] Phase 1 resource reference: 2 warmups + 20 timed jobs per page, CPU and DML,
  three pages. None of them meets the deskew trigger.
- [x] Inventory of trigger pages: 8 of 1,173 (five rendered at −1.5° with ledger
  gold, three 文部時報 1277 pages without gold); body and ruby CER of the rendered
  ones frozen.
- [ ] Decide with the user: targets and the "each target improves" criterion (only
  one target has headroom), gold for real leaning pages, and facing pages that lean
  differently (out of reach of one rotation).
- [ ] Measure a triggered page under Phase 1 with the same protocol (denominator of
  the 2.5 times budget); needs the probe extended beyond the frozen manifest.
- [ ] Render and freeze further skew targets before any deskew code exists.

- [ ] Implement conditional expanded-canvas deskew, one repeat and coordinate lineage.
- [ ] Update profile declaration; pass geometry, quality, failure and resource gates.
- [ ] Pass new holdouts, prior-phase regression, packaged consumers and independent review.

## Phase 3A — locked by Phase 2

- [ ] Pin/verify NDL assets and licenses; evaluate exact candidate on CPU and DML.
- [ ] Pass all-session execution proof, quality/false-text guards, new holdouts and budgets.
- [ ] Freeze the passing policy and obtain independent review.

## Phase 3B — locked by Phase 3A

- [ ] Integrate the frozen policy and profile v3 without changing the public box shape.
- [ ] Verify score semantics, assets, all sessions, cancellation and complete regression.
- [ ] Pass integrated resource budgets and installed consumer journeys; independently review.
- [ ] Deliver a release-ready candidate and evidence for a separate publication decision.
