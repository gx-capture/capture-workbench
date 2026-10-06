# Phase 2 preparation — raster deskew and one retry

Prepared 2026-10-06 at the user's request. No Phase 2 product behavior is
implemented and no gate is claimed. Phase 2 is specified in the
[approved spec](../SPECS/vertical-japanese-ocr.md); Phase 1 ends at candidate 09,
see the [Phase 1 record](vertical-japanese-ocr-phase1-implementation-2026-10-02.md).
Evidence files are under `tmp/vertical-japanese-ocr-phase0/phase1/` (ignored).

## What Phase 2 is for, measured

Phase 2 rotates the raster and recognizes once more when a vertical or mixed page
leans between 1 and 5 degrees. Its purpose is recognition, not order: the reading
order already works in a deskewed analysis frame without touching the raster.

The one retained page where this matters is the rendered page `p04_inn_full` at
−1.5°: five of its nine long columns are recognized as a few stray characters
(scores 0.37 to 0.51), and the body has 294 edits in 394 characters on both
providers. The same page at 0°, at +0.8° and after the scan degradation has 10 to
35 body edits. No ordering can repair it; a second recognition on an upright
raster is the only candidate remedy in the plan.

## Baselines frozen for Phase 2

Source: candidate 09, `ocr_reading_order.py` SHA256
`da37503e60f4bc29673d9d0513e61cf9be48a3d0a6b99df05e46a6a18144fe84`, the other
runtime modules unchanged since candidate 03.

### Resources (the "relative to Phase 1" reference)

Same method as the Phase 0 source-worker run it is compared with: real
`WorkerClient` and PDF worker from source, a fresh worker per job, two warmups and
twenty timed jobs per page, nearest-rank p95, native per-process working-set
peaks with complete Job accounting. Other processes of this session ran on the
machine during the first part of the DML run; the timed samples show no outlier.

| Page | DML p95 s | CPU p95 s | DML RAM MiB | CPU RAM MiB | Phase 0 DML / CPU p95 s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2024-07 p2 (horizontal) | 4.918 | 5.194 | 958–971 | 1233–1246 | 6.007 / 5.186 |
| official N1 p14 | 5.231 | 7.235 | 801–813 | 1182–1195 | 6.421 / 6.909 |
| Bunka p2 | 8.103 | 12.103 | 1020–1032 | 1334–1346 | 7.535 / 12.600 |

RAM is the lower and upper bound of the peak sum of per-process working sets.
`resource-baseline-dml-09/completed.json` SHA256
`8fbb9c85ef401481b274f1ceff0fd3c8e6d8b6215cec425dcc8015388e660993`;
`resource-baseline-cpu-09/completed.json` SHA256
`cd89ae20749d9ba17cec94f57657965fd3a7affd680533ebf1f0f9afd73121ed`.

Limits: wall time of `WorkerClient.run` including startup, model load, PDF raster,
OCR and cleanup, so most of each sample is fixed cost; no HTTP, host or packaged
measurement; `execution_proof` is null as in Phase 0. **None of these three pages
meets the deskew trigger**, so the budget "triggered-page warm p95 at most 2.5
times Phase 1" has no Phase 1 number yet (first task below).

### Pages that meet the initial trigger

Trigger: at least three long lines, consistency at least 0.6, 1 ≤ |skew| ≤ 5
degrees, reading-order policy applied. Over all 1,173 retained and exposed pages,
107 are vertical or mixed and **8 trigger**:

| Page | Skew ° | Consistency | Gold |
| --- | ---: | ---: | --- |
| rendered `p01`, `p02`, `p03`, `p04`, `p06` at −1.5° | −1.40 to −1.49 | 0.99–1.00 | renderer ledger |
| 文部時報 1277 p13 | −1.07 | 0.97 | none |
| 文部時報 1277 p1, p7 | −1.06, −1.07 | 0.66, 0.60 | none |

91 vertical pages lean less than 1 degree (the rendered +0.8° variants among
them) and none more than 5. Eight more are scans of two facing pages that lean
differently (per-page frames from −1.42 to +1.70 degrees): their page-wide
consistency is below 0.6, so the trigger does not fire, and one rotation could
not straighten both pages anyway.

Body and ruby CER of the rendered trigger pages under candidate 09, by ledger
roles, identical on CPU and DML (`phase2-skew-targets-da37503e60f4.json`, SHA256
`00f88847948426e87467316d3c263115e93c426f33384b77c0cf25bfdd042eec`):

| Rendered page at −1.5° | Body edits / characters | Ruby edits / characters |
| --- | ---: | ---: |
| p01 letters | 12 / 605 | 1 / 16 |
| p02 remote A/B | 8 / 543 | 0 / 3 |
| p03 AI gothic | 11 / 518 | 0 / 4 |
| p04 inn | **294 / 394** | 2 / 12 |
| p06 population | 1 / 530 | 0 / 4 |

## Problems to settle before implementing

1. **Too few targets with headroom.** The spec asks that on each predefined
   target at least one of body or ruby CER improves and neither gets worse. Four
   of the five targets with gold are already at 1 to 12 body edits, so "must
   improve" is mostly noise there, and the whole case for Phase 2 rests on one
   rendered page. More targets are needed (rendered pages at −3° and ±5°, and
   real leaning scans with transcription), or the criterion needs the user's
   revision, for example "no page worse, the set better in total".
2. **No real target has gold.** The three 文部時報 1277 pages trigger at about
   −1.06°, two of them with consistency at the threshold. Whether rotation helps
   real scans is unknown; they need at least a body transcription of some columns.
3. **Facing pages are out of reach by design.** The real leaning scans in the
   material are mostly facing pages with different lean. A single rotation with a
   consistency gate skips them. Deskewing each page of a spread separately would
   be a larger design than the spec describes and belongs in a decision, not in
   the implementation.
4. **Interaction with Phase 1 state.** After a retry the chosen inference
   replaces the first one entirely: its alignment records feed the cross-band
   split and its regions feed the reading order. Polygons then have to be mapped
   back to the original raster, where they are no longer axis-aligned. The
   reading-order policy already handles skewed polygons; the split's
   raster-whitespace test reads pixels and must be given the rotated raster or be
   re-derived.
5. **Profile identity changes.** `preprocessing.deskew` is declared
   `{"enabled": false, "owner": "none"}` in `assets/ocr-profile.json` and enforced
   in `ocr_profile.py`. Declaring it changes the profile digest and id, which the
   engine catalog, provenance and consumers pin. That is a contract change to
   plan with the release runbook, not a detail.
6. **Cost on triggered pages only.** A retry doubles inference on a triggered
   page. Whole-job p95 has a large fixed share, so 2.5 times is likely loose; the
   real risk is the 512 MiB RAM increment if the rotated raster and the second
   result are held together with the first.

## Where it goes in the code

- `WindowsMLOcrAdapter._extract_png_locked` in `engine_adapters.py`: one
  `_predict` call inside the alignment collector (lines near 1978). The retry
  wraps this: predict, normalize, estimate skew on the normalized regions, and
  when the trigger holds rotate the PNG with Pillow on an expanded white canvas
  and predict again inside a new collector. A second-predict failure must fail
  the job through the existing path, not fall back to the first result.
- `estimate_page_skew` in `ocr_reading_order.py` already returns degrees, line
  count and consistency. The trigger also needs "vertical or mixed", which today
  is the reading-order decision; that decision should be made once and shared.
- Coordinate mapping: a pure function for the expanded-canvas rotation and its
  inverse, tested for unclamped round trips and for boxes at the canvas edge, as
  the spec requires. `scripts/ocr_benchmark_synthetic.py` already has a tested
  forward/inverse matrix for the same rotation convention.
- `raster_width` and `raster_height` in the result must stay those of the
  original raster; `validate_region_sources` and the worker's box checks expect
  polygons inside it.
- Profile: `ocr-profile.json`, `ocr_profile.py`, and whatever pins the profile
  digest (catalog generation, `OcrProvenanceV3`, consumer fixtures).

## First tasks, in order

1. Decide items 1 to 3 above with the user (targets and criterion, real-page
   gold, facing pages).
2. Extend the source-worker probe so it can run a triggered page (a 1277 page or
   a rendered −1.5° page as PDF) and measure its Phase 1 p95 and RAM with the
   same 2 + 20 protocol. This is the denominator of the 2.5 times budget.
3. Render the additional skew targets and freeze their ledgers before any
   deskew code exists.
4. Write the rotation mapping and its tests, then the adapter retry behind the
   trigger, then the profile change.
5. Fresh unseen leaning pages are needed for acceptance; every page listed here
   is now a development input.

## Not part of Phase 2

Page structure of dense periodical scans (page, band, heading order) is a
recorded Phase 1 limitation and is untouched by deskew. Missing option markers
and dropped punctuation in recognized text are detection and recognition issues
that Phase 3 evaluates, not Phase 2.
