# Vertical reader — routing vertical-dominant pages to NDLOCR-Lite

2026-10-06. Implemented at the user's approval after the
[direction study](vertical-japanese-ocr-direction-study-2026-10-06.md); candidate
11 of the vertical work. Evidence files are under
`tmp/vertical-japanese-ocr-phase0/` (ignored). No recognized page text is stored
in this note or in the repository.

**Current state is the 0.5.0 release source, described in the last section. The
sections before it describe candidates 11 and 12 and are kept as measured.**

**Status: in the runtime, verified with the reader installed by hand, inactive in
the released engine.** The engine catalog does not deliver the reader's models;
that is a release-lane change that has not been made and needs the user's
approval. No phase or gate is claimed.

## What it does

Every page still gets the regular first pass (PP-OCR on DirectML or CPU). Then:

1. **Routing** (`ocr_vertical_routing.py`, standard library). A page is routed
   when the reading-order policy treats it as vertical (so sideways scans, chart
   marks and unreadable boxes are already refused), at least three boxes are tall
   (height at least twice the width, two or more characters), and at least 80% of
   the recognized characters lie in tall boxes.
2. **Reading** (`ocr_vertical_reader.py`). A routed page is read as a whole by
   NDLOCR-Lite's models on the CPU provider: one line detector and three line
   recognizers chosen by predicted line length, with overflow to the next longer
   one. Layout grouping and reading order are upstream's code, vendored.
3. **Result.** The reader's non-empty lines, in its order, become the page's
   regions; the page text is the lines joined by newlines; each region's score is
   the mean of the recognizer's per-character top probability (upstream reports
   no recognition score). Polygons are the line rectangles clipped to the raster.
   Composite splitting, the reading-order policy and region lineage do not apply
   to a routed page.

Everything else keeps the regular pipeline's result unchanged: horizontal pages,
pages with a boxed vertical passage among horizontal questions, and any page when
the reader is not installed.

Failure rules:

| Situation | Outcome |
| --- | --- |
| Reader directory absent | Regular result; no routing record |
| Reader files missing, resized or with another digest | Page fails |
| Model load or inference raises | Page fails |
| Layout or ordering of the detected lines raises | Regular result, reason recorded |
| Reader returns no text, or under half the first pass's characters | Regular result, reason recorded |

The decision is recorded on the internal result (`OcrTextResult.page_route`:
reader, reason, share, counts). It is not in any public contract.

## Source and licence

NDLOCR-Lite, National Diet Library, Japan, commit
`636d1cfeb1331f89f4048f416e49e23a09a714b5` (version 1.2), CC BY 4.0.

- **Vendored** under `src/capture_runtime/_vendor/ndlocr_lite/`: `ndl_parser.py`
  and the `reading_order` package, with three import edits and LF line endings.
  `scripts/vendor_ndlocr_lite.py` reproduces the directory from an upstream
  checkout and pins each source file's digest; the directory's `README.md` lists
  the edits and `LICENCE` is upstream's. The files are excluded from linting and
  type checking.
- **No new dependency.** Upstream needs `networkx` for two calls in
  `smooth_order.py`; `_digraph.py` replaces them. Against networkx 3.3 it returns
  the same paths in the same order on 3,050 graphs (103,208 paths), including the
  shape `smooth_order` builds (`digraph_equivalence.py`). The first version
  differed for a one-node graph, where networkx yields the trivial path; the
  comparison found it and it was fixed. `lxml` and `tqdm` are imported upstream
  but not used by the functions called.
- **Rewritten** in the runtime: the detector and recognizer wrappers and the
  cascade (upstream `deim.py`, `parseq.py`, parts of `ocr.py`), step for step,
  including one upstream quirk kept for identical results (filtered boxes are
  paired with the unfiltered class array).
- **Models** (not in the repository; pinned by size and SHA-256 in
  `ocr_vertical_reader.py`): `deim-s-1024x1024.onnx`, three `parseq-ndl-*.onnx`,
  `ndl.yaml`, `NDLmoji.yaml`; 149.9 MiB. They are expected in a `vertical`
  directory beside the regular models.
- The OCR worker archive carries the vendored `LICENCE` and `README.md`. The core
  executable and the Whisper worker exclude the reader and the vendored code.

## Evidence

### The reader equals upstream

`differential_reader.py`: the runtime's reader against the output of the
unmodified upstream program run in its own environment, on every retained raster
that has such output.

| Pages | Lines | Characters | Text and order equal | Boxes equal |
| ---: | ---: | ---: | ---: | ---: |
| 106 | 9,625 | 172,517 | 106 | 106 |

So the accuracy and order measurements of the direction study (findings 2 and
follow-up 2) apply to the runtime's reader as measured. In CI the vendored layout
and ordering code is checked without models: recorded line detections of five
pages must give the line order that unmodified upstream gave
(`tests/fixtures/vertical-ocr/vertical-reader-layout.json`, numbers only).

### Which pages are routed

`routing_replay.py`: the product decision replayed over every retained first
pass.

| Material | Pages | Routed | Mixed directions | Not vertical |
| --- | ---: | ---: | ---: | ---: |
| N1 papers, development | 167 | 0 | 3 | 164 |
| N1 papers, supplied | 884 | 0 | 3 | 881 |
| Official N1 sample | 3 | 1 | 0 | 2 |
| Bunka archive | 6 | 5 | 1 | 0 |
| Monthly 117, 001; jiho 1277 | 27 | 22 | 1 | 4 |
| Public archive periodicals | 27 | 22 | 2 | 3 |
| MEXT bulletin | 35 | 14 | 13 | 8 |
| Private Chinese case file | 45 | 0 | 0 | 45 |

64 of 1,194 pages are routed. The one exam page routed is the official sample
with two vertical passages, where the reader missed 24 of 793 characters against
91 for the regular pipeline. No page of an N1 paper with a boxed passage and no
page of the Chinese case file is routed.

### Workers

Ten development pages per provider through the real `WorkerClient` and PDF
worker, a fresh worker per page (`verify_fresh_workers_11.py`, artifacts only):

| Check | CPU | DML |
| --- | --- | --- |
| Without the reader: eight pages equal candidate 10 (boxes, text; scores exact on CPU) | pass | pass |
| With the reader: six pages that are not routed equal the run without it | pass | pass |
| With the reader: four routed pages equal upstream's output line for line (official p14: 40 lines; Bunka p1, p2, p4: 37, 111, 136) | pass | pass |
| Routed pages identical between providers, scores included | pass | pass |
| Frozen (PyInstaller) worker with the reader: all ten pages equal the source worker | — | pass |
| Controlled faults rejected | 7 | — |

Local package journey over real HTTP, with models installed from the catalog and
therefore without the reader: 660 boxes on ten pages identical to the source
worker without the reader; LAW readback of the same 660 boxes unchanged. This
shows the change is inert in a package built today.

Nx lint, typecheck, unit and integration pass: 1,038 Python unit tests (two recorded expected failures), 22 TypeScript, 216 integration.

| Evidence | SHA256 |
| --- | --- |
| `ocr_vertical_reader.py` | `f0fa8975a3eea5db2d7cfb86ccc698e1e0cab65c5a59e17e0186b6bbca46606d` |
| `ocr_vertical_routing.py` | `b686ca20cf557e53c071dd4f1bc46ddc5bcb5ed8afa45801b39a4868c83e1391` |
| `engine_adapters.py` | `39c1409007f0c6f95077e25ffb9c84ee07842306b02eb19e28c67abbb4e343f9` |
| `direction-study/differential-reader.json` | `565ae1616fb8c8e77f3e311516dc54938a28d7b607526090430cbcd70bc7fa7a` |
| `direction-study/routing-replay.json` | `fd1c7ea37d58d9659ce93fff2e5e4cdfd8d28e3d3f0a31be5e31b6a8a8c622b5` |
| `phase1/fresh-worker-dml-11/completed.json` (no reader) | `3b7c74cd66086e7952875ef802c41241acec662cd43cb27bed7f5523accaf327` |
| `phase1/fresh-worker-cpu-11/completed.json` (no reader) | `c4fa534df8c54e6c2b3d7178014a8f00653735d4bed6481b8634f4daf418ad70` |
| `phase1/fresh-worker-dml-11v/completed.json` (reader) | `18ada387e773ac15035fdcac146efd58a983d2501039dbcd1392557d4a437099` |
| `phase1/fresh-worker-cpu-11v/completed.json` (reader) | `c1f3df03b0bbd7c33137ad8d291901e04117eb861fabc719c8c295680a5df0af` |
| `phase1/frozen-worker-dml-11v/completed.json` | `98ff32b62eea76f89faacfe7373006c8edaaa2672d3a0238688f7bf78fe3a802` |
| `phase1/fresh-worker-verification-11.json` | `21c16a3d6769c3a3d24c3b0b409e826e79bbcef7216ec179ef6ab49ae8ecc494` |
| `phase1/packaged-semantic-11/verification.json` | `42193f7804db3a3afc090adc8252a2eb50262803bb82145c615f1b0701ba380a` |
| `phase1/law-receipt-readback-11.json` | `695868b55089bcc934cf4bb0fc990bf3772244690cc7d78239455b3604db55a5` |
| `phase1/resource-vertical-dml-11b/completed.json` | `907dba89e8cb977013432a2c20e5da8afffca8c99086292ead85263434252c2f` |
| `phase1/resource-vertical-cpu-11/completed.json` | `ac752535a78e9661dbbfc937e4fc7e63c2a0d87ca8ba72e067a158edfc4b3e00` |

### Cost of a routed page

Same protocol as the candidate 09 reference it is compared with: real
`WorkerClient`, a fresh worker per job, two warm-ups and twenty timed jobs per
page, nearest-rank p95, native per-process working-set peaks
(`summarize_resources_11.py`).

| Page | Provider | p95 routed / candidate 09 | Ratio | Peak RAM routed / candidate 09, MiB | Increase, MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| Official N1 p14 | DML | 21.5 s / 5.2 s | 4.1 | 1,327–1,340 / 801–813 | 526 |
| Bunka p2 | DML | 25.9 s / 8.1 s | 3.2 | 1,410–1,423 / 1,020–1,032 | 390 |
| Official N1 p14 | CPU | 22.3 s / 7.2 s | 3.1 | 1,828–1,840 / 1,182–1,195 | 646 |
| Bunka p2 | CPU | 25.5 s / 12.1 s | 2.1 | 1,891–1,903 / 1,334–1,346 | 557 |

**A routed page costs about 14 to 18 s more per job and 390 to 646 MiB more.**
The only cost budget in the spec was written for the deskew retry (2.5 times the
Phase 1 p95 and 512 MiB); three of the four time cells and three of the four
memory cells are over it. The user has not set a budget for this route.

Where the time goes: creating the four ONNX Runtime sessions takes about 10 s,
once per worker process (the long-line recognizer alone about 5 s; ONNX Runtime
did not create them concurrently when tried); reading a page takes 0.7 to 2.9 s.
Because this protocol starts a worker per job, every job here pays the start-up;
a document with many routed pages pays it once. Pages that are not routed pay
nothing: the reader is loaded only when the first page is routed.

One DML measurement attempt stopped at its thirteenth job with a failure of the
regular pipeline's adapter-map check during pipeline creation, before any reader
code runs (`resource-vertical-dml-11`, kept, not used). The machine had been idle;
the repeat ran all 44 jobs. An earlier DML attempt was discarded because a source
file was edited while it ran.

## Limits

- **Not delivered.** A packaged engine has no reader until the release lane adds
  it; today's packaged output is unchanged.
- **Public provenance of a routed page is wrong as it stands.** It names the
  regular model, its digest and the first pass's device, while the text came from
  another model on the CPU. This must be settled with the profile and provenance
  contract before delivery.
- **Cost.** Over the only budget the spec has (see above). A routed page pays the first pass and the reader, and each worker
  process that reads a routed page pays the reader's start-up once.
- **Mixed pages** (vertical by the policy but under 80%; mostly the MEXT bulletin and a few
  periodical pages) stay with the regular pipeline, including its page-structure
  limitation on dense scans.
- **Ruby** on a routed page is whatever upstream returns; it is not separated into
  a run as the regular vertical path does.
- **No unseen acceptance and no independent review.** Every page here is a
  development or already exposed page, the threshold was chosen on them, and
  upstream's training data may include periodicals like these.
- The reader's scores are a different quantity from the regular pipeline's and
  are not calibrated against it.
- Cert parsing was not run on routed pages; exam pages with a boxed passage are
  not routed, so Cert's input is unchanged.

## Release-lane work (needs the user's approval)

1. Model source lock: the six files and upstream's licence, with owner, revision
   and SPDX `CC-BY-4.0`; the lock carries a recorded approval.
2. Engine catalog and installer: deliver the files into `model/vertical`.
3. OCR profile: declare the reader, its models and the routing rule; this changes
   the profile digest and id that the catalog, provenance and consumers pin.
4. Provenance of a routed page (model, digest, device) and the attribution text
   in the distribution.
5. Optional: deliver ONNX Runtime-optimized derivations of the models. Optimized
   offline at the extended level they load in about 4 s instead of about 10 s and
   gave the same text and order on the 106 pages; they are derived files, which
   the lock can record.
6. Version the engine and follow the release runbook.

## Reducing the cost of a routed page (evaluation, 2026-10-06)

Requested by the user. Measurements only; the product code is unchanged
(`direction-study/perf_one.py`, `perf_patch.py`, `perf-control`, `perf-arena`,
`perf-full`, `perf-unrouted`). The machine was about twice as slow during this
session as during the measurement above (the regular pipeline took 11 to 14 s per
job instead of 5 to 8 s), so only numbers from the same session are compared.

### Where the cost is

- Start-up of the reader is session creation; loading with graph optimization
  switched off is slower still, so the time is initialization of large recognizer
  graphs, which optimization shrinks.
- Memory: the four sessions hold about 320 MiB; reading a page raises the process
  peak to about 1,000 MiB, which is ONNX Runtime's CPU memory arena under 24
  recognizer threads.

### What was tried

| Change | Effect | Same text and order |
| --- | --- | --- |
| Models optimized offline at the extended level, loaded without further optimization | Reader start-up 14.9 s to 5.5 s in one process | Yes, 106 pages |
| CPU memory arena off | Process peak 1,210 MiB to 636 MiB over 106 pages; read time unchanged within noise | Yes, 106 pages; scores identical |
| Both | Start-up 23.3 s to 6.9 s, peak 1,210 MiB to 600 MiB (a slower moment of the session) | Yes, 106 pages; scores differ by at most 1e-6 |
| ORT-format models | No gain over optimized ONNX | — |
| Creating recognizers only when first needed | No gain: a page uses all three | — |
| Fewer recognizer threads (2, 4, 8) | Reading 1.3 to 4 times slower, little memory saved | — |
| Creating the sessions concurrently | No gain | — |

### In the real worker

DML, a fresh worker per job, two warm-ups and twenty timed jobs per page, run one
after another in the same session:

| Page | Regular pipeline | Routed, as committed | Arena off | Optimized models, no load-time optimization, arena off |
| --- | ---: | ---: | ---: | ---: |
| Official N1 p14, median s | 11.2 | 30.5 | 33.9 | 20.3 |
| Bunka p2, median s | 13.8 | 35.7 | 36.7 | 23.3 |
| Official N1 p14, peak RAM MiB | 813 | 1,342 | 1,118 | 1,059 |
| Bunka p2, peak RAM MiB | 1,032 | 1,400 | 1,217 | 1,167 |

(The regular pipeline's RAM is the candidate 09 reference; its time was measured
last in this session.)

- Extra time of a routed job: about 19 to 22 s as committed, about 9 s with the
  full change; the ratio to the regular pipeline goes from 2.6–2.7 to 1.7–1.8.
- Extra memory: 368 to 529 MiB as committed, 135 to 246 MiB with the full change.
- Boxes and text are identical in all three; scores are identical with the arena
  off and differ by at most 1e-6 with the optimized models.
- With the arena off alone the jobs were 1 to 3 s slower than the control in this
  run; in a single process the read time was unchanged. The runs were sequential,
  so drift of the machine is not excluded.

### Not measured

- Keeping one worker for a whole document already pays the start-up once; a
  worker kept across jobs would remove it for later jobs.
- Loading the reader while the first pass runs would hide the start-up, but every
  job, including horizontal exam pages, would then pay its CPU and about 300 MiB
  unless the host says in advance that a document is vertical (a contract change).
- Deciding the route before the first pass would save the first pass on routed
  pages but needs another signal and touches the DirectML execution evidence.

### Assessment

The full change roughly halves the added time and memory and keeps the text
identical. It needs derived model files in the delivery (the lock can record a
derivation), a digest table for those files instead of upstream's, and two session
options. The remaining cost is about 5 to 7 s of start-up per worker process, 2 s
per page, and the first pass.

## Candidate 12 — lower cost and recognizers on the GPU (2026-10-06)

Approved by the user after the evaluation above, with the request that the reader
use the GPU where it can.

### What changed

- **Derived recognizers.** The three recognizers are upstream's models after ONNX
  Runtime 1.24.4 extended graph optimization on the CPU provider, saved under the
  same names and loaded with optimization off.
  `scripts/derive_vertical_reader_models.py` checks upstream's digests, derives
  the files and checks them against the digests the runtime pins; two runs gave
  identical bytes. The detector and the two configuration files stay upstream's.
- **Memory arena off** for all four sessions.
- **Recognizers on DirectML** when the regular pipeline runs on DirectML: same
  device id, memory pattern off, sequential execution, one line at a time (calls
  into a DirectML session cannot overlap). On a CPU plan they run on CPU threads
  as before. A recognizer that is not placed on DirectML fails the page.
- The routing record gains the recognizers' device.

### What the GPU can and cannot do

| Model | On DirectML |
| --- | --- |
| Line detector | **Wrong output** on both adapters of this machine at every optimization level: 7 boxes over the threshold instead of 131 on the test page, top score 0.40 instead of 0.99. Stays on the CPU, where it takes 0.4 s per page. |
| Three recognizers | Work. Same characters as the CPU on every line of 106 pages; logits differ by up to 0.05. |

Reading a page takes about the same wall time either way (median 1.3 s on 24 CPU
threads, 1.5 s on the dedicated GPU with one thread, 1.7 s on the other adapter);
the gain from the GPU is that reading no longer occupies every CPU core. The
operator in the detector that DirectML computes differently was not identified.

### Evidence

`differential_reader.py`, the product reader against unmodified upstream:

| Recognizers on | Pages | Lines | Text and order equal | Boxes equal |
| --- | ---: | ---: | ---: | ---: |
| CPU | 106 | 9,625 | 106 | 106 |
| DirectML, dedicated adapter | 106 | 9,625 | 106 | 106 |
| DirectML, other adapter | 106 | 9,625 | 106 | 106 |

A first version also derived the detector; text and order were equal but boxes
differed on 3 of 106 pages, so the detector was put back to upstream's file.

Workers (`verify_fresh_workers_12.py`, ten pages per provider, artifacts only):
without the reader eight pages equal candidate 10; with it six pages that are not
routed equal the run without it and four routed pages equal upstream line for
line on both providers; routed text and boxes agree between providers while 7 of
40 and 26 of 111 scores differ by at most 4e-6, which is the recognizers running
on DirectML in the DML worker; the frozen worker equals the source worker on all
ten pages; seven controlled faults rejected. Package journey without the reader
and LAW readback: 660 boxes unchanged. Nx: 1,043 Python unit tests (two recorded
expected failures), 22 TypeScript, 216 integration.

### Cost

Regular and routed jobs measured in one session, a fresh worker per job, two
warm-ups and twenty timed jobs per page (`summarize_resources_12.py`):

| Page | Provider | Median regular / routed, s | Added, s | p95 regular / routed, s | p95 ratio | Peak RAM increase, MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Official N1 p14 | DML | 5.6 / 14.8 | 9.3 | 6.2 / 19.7 | 3.2 | 416 |
| Bunka p2 | DML | 7.3 / 15.3 | 7.9 | 7.8 / 16.9 | 2.2 | 350 |
| Official N1 p14 | CPU | 6.9 / 14.0 | 7.1 | 7.2 / 15.6 | 2.2 | 351 |
| Bunka p2 | CPU | 11.5 / 18.9 | 7.4 | 11.9 / 19.5 | 1.6 | 310 |

Candidate 11 added 14 to 18 s and 390 to 646 MiB. Against the deskew budget of
the spec (2.5 times, 512 MiB), memory is inside in all four cells and time in
three; the fourth (official p14 on DML) has a p95 of 19.7 s because its last four
jobs took 19 to 20 s while the sixteen before took 13.5 to 18 s, and its median
ratio is 2.7. The added time is still mostly start-up of the four sessions, paid
once per worker process.

On this machine the GPU does not make a routed job faster than the CPU plan does;
it frees the CPU cores during reading.

| Evidence | SHA256 |
| --- | --- |
| `ocr_vertical_reader.py` | `a4c3a65091d0e844eb19ea60acf0be6b8739beb577dca0f7460f5a9472017c7e` |
| `ocr_vertical_routing.py` | `b5f7b599625952a7dfcd1c17454da274a01a7cf464d8535b9d9b55eba872c0c3` |
| `engine_adapters.py` | `695785587371bb23f6e54d88ad224ab214221ee707596687df042da9371b0198` |
| `direction-study/differential-reader.json` | `03aa460a26f21e5e70d57dc16dd34a25930c072ad016ac279dbeb00ef29d512f` |
| `direction-study/differential-reader-dml1.json` | `f5d7025fa537d25d3df72fb806d02d5e6d883a01092ce91219b085b2437843ff` |
| `direction-study/differential-reader-dml0.json` | `26a607d8e352a3a04246d58613419aae2d7eab9d5162d82b33c2a7909b72f547` |
| `phase1/fresh-worker-dml-12/completed.json` (no reader) | `55c42164845b31cbaaa0532ac2157c1dfe08a89ffffa694aca2ba7dca276c1fd` |
| `phase1/fresh-worker-cpu-12/completed.json` (no reader) | `714bc2cf9dd55c106e81663d6c24f104992293d975420d21afa1d5d95b1ef888` |
| `phase1/fresh-worker-dml-12v/completed.json` | `45decee95fac1cdd91050ed1491adea64cb1f713c72343c408be5be371d510e6` |
| `phase1/fresh-worker-cpu-12v/completed.json` | `1205d82db30c0d3c2cc83548be76dee3bdf850f694c0fd0be99a7b4e1a335948` |
| `phase1/frozen-worker-dml-12v/completed.json` | `a04ca72314a4f9071afae52d3cee477560f906904e90bc3113836e2a8e24a8a9` |
| `phase1/fresh-worker-verification-12.json` | `f4da76f9d17f59938cbad7ce752107580eb0eefbf24039ed307de8db1a6b891e` |
| `phase1/packaged-semantic-12/verification.json` | `deeceb99f588fff1be675e64b238e27e14673a65b5a6e62e689f0a540a47ce1d` |
| `phase1/law-receipt-readback-12.json` | `a54dfaf921cafa43058162612989efea589b8a41aef559f27c693c6da68486a3` |
| `phase1/resource-vertical-summary-12.json` | `5b3c9c288688d9045232e5afa355f1e4930833d1216d2a09ba79c371ccc7a762` |

### Limits added by this candidate

- Equality of DirectML and CPU text was shown on two adapters of one machine.
  Other GPUs and drivers may round differently; nothing in the runtime detects a
  recognizer that returns other characters on another device.
- The regular pipeline's DirectML execution evidence and device proof do not
  cover the reader's sessions: that the recognizers ran on DirectML is checked
  only by the provider the session reports.
- The derived files depend on the ONNX Runtime release that made them; the
  runtime that loads them must be able to read that release's optimized graphs.
- The delivered recognizers are no longer upstream's bytes, so attribution has to
  say they were modified (CC BY 4.0).

## Release source 0.5.0 — delivery and derivation on the machine (2026-10-06)

The user approved entering the delivery flow, chose version 0.5.0, and chose that
derived recognizers are produced on the user's machine instead of being committed
to the repository (about 113 MiB of binaries, and redistribution of modified
models) or left out.

### What changed from candidate 12

- **Delivered files are upstream's bytes.** The model source lock lists the six
  files as `source` entries from `raw.githubusercontent.com/ndl-lab/ndlocr-lite`
  at commit `636d1cfe`, with upstream's `LICENCE` and `README.md` as licence and
  notice. The OCR requirement is now 18 files, 282 MiB (150 MiB more).
- **Derivation on the machine.** On first use each recognizer is optimized by ONNX
  Runtime (extended level, CPU provider) into the shared engine cache, in the
  cache's own layout (`<sha256[:2]>/<sha256>`), and accepted only with the pinned
  size and digest; later runs load it from there. With the cache off, unwritable,
  or other derived bytes, the upstream file is loaded with full optimization.
  Nothing in this path fails a page.
- **Profile v3.** `verticalReader` in the profile declares source, revision,
  licence, delivered files, derived digests, devices and routing rule; the runtime
  refuses a profile that differs from its own constants, and a unit test holds the
  standalone generator to the same declaration. Profile id
  `capture-workbench-ocr-1c6be4a3cebc2b21`.
- **Version 0.5.0**: version sync, regenerated contracts (contract-set
  `4c63044191551bf3f7c36d24d08cc6ced25fcc701bf1e06a0fa69626b1e18f1b`), refreshed
  Python and Cargo locks, model-source snapshot commit
  `8f37898ac6b3b51c0d4e1e44aa7ea53e693f6815` tagged
  `capture-runtime-model-sources-v0.5.0`.

### A mistake found on the way

The digests first pinned for the two configuration files, and for the vendored
sources in `vendor_ndlocr_lite.py`, were taken from a checkout with `autocrlf`,
so they were digests of CRLF copies. Upstream stores LF. Comparing with the git
blobs and with a real download from the raw URL showed it before the lock was
written; the pins are now upstream's bytes (`ndl.yaml` 299 bytes,
`NDLmoji.yaml` 42,434 bytes), the vendoring script normalizes a CRLF checkout
before comparing, and every evidence run below used the corrected files.

### Evidence

`differential_reader.py`, the product reader with upstream's files against
unmodified upstream, 106 pages and 9,625 lines each:

| Run | Start-up, s | Text and order equal | Boxes equal |
| --- | ---: | ---: | ---: |
| CPU, first run (derives into an empty cache) | 10.9 | 106 | 106 |
| CPU, cached | 3.8 | 106 | 106 |
| DirectML dedicated adapter, cached | 4.8 | 106 | 106 |
| DirectML other adapter, cached | 6.2 | 106 | 106 |
| CPU, cache off | 7.7 | 106 | 106 |
| DirectML dedicated adapter, cache off | 9.5 | 106 | 106 |

Workers on the 0.5.0 source (`verify_fresh_workers_13.py`, ten pages per provider,
model directory assembled from the files the lock pins, scratch engine cache):
six pages that are not routed equal the candidate 12 run without the reader; four
routed pages equal upstream line for line on CPU and DML and agree between
providers; the frozen worker equals the source worker; seven controlled faults
rejected.

**Local package journey with the reader installed from the catalog**
(`verify_local_package_13.mts`): locally built 0.5.0 runtime, catalog and OCR
worker, real HTTP, models installed by the engine installer from a staging of the
18 locked files (licence and notice downloaded from upstream's URLs and matching
the lock), engine cache off. Ten pages, 619 boxes, identical to the source worker,
four routed pages among them.

LAW readback was not repeated: LAW's model pins `runtimeVersion` to `0.4.4` and
rejects a 0.5.0 projection. That is the consumer migration of the release
runbook, not a defect of this change.

The 41 commands of the CI workflow that run without a desktop installer were run
locally on the final tree and pass (runtime: 1,050 unit and 216 integration tests, two recorded
expected failures; the workspace's TypeScript, Python, Java, Rust and Angular
clients, launcher, desktop crate and release tooling). Three needed attention: the
Angular library's `CAPTURE_RUNTIME_MINOR` still said 4 and now says 5; an ignored,
locally staged desktop manifest was stale and was re-staged; and the promotion
registry tests fail under Git Bash because its `tar` reads `C:` as a host, and pass
from PowerShell.

| Evidence | SHA256 |
| --- | --- |
| `phase1/fresh-worker-dml-13/completed.json` | `ea150a955ca9d26d82e56ba1a04d60945af027d4a2bdff65269af0b1a639886a` |
| `phase1/fresh-worker-cpu-13/completed.json` | `9b14712db228de004ad034111ace805e1e3d5d7ca7cb8dedad099923602114d0` |
| `phase1/frozen-worker-dml-13/completed.json` | `a34303d395128658b3e2649a9f7f0505fb3b597a2ab24bc7fb5367d84a119972` |
| `phase1/fresh-worker-verification-13.json` | `db5fed2c5d451dd62be7a40ae50e6ac9079e8bfa4999ec44db97a481436e6a6f` |
| `phase1/packaged-semantic-13/verification.json` | `19fe33c5e8acbf57fab945e78c125f71cf90f931191a6ebf84913d0b1dc89959` |
| `direction-study/differential-reader-cpu-first-run.json` | `8bce78bba7b16d0905ec8d1fc56949e5db02d3053a2db9b98ce051e930df2686` |
| `direction-study/differential-reader-cpu-cached.json` | `dab42632ebd444978ecd9ca06f96a6f0d7812aac2ba9c927e2bb99a6be89a2c5` |
| `direction-study/differential-reader-dml1-cached.json` | `e6d946ea67272070aab4b3c7d5cef737570a32d7f972677eb35b97f0ac1ae32b` |
| `direction-study/differential-reader-cpu-no-cache.json` | `403efc71f49aac59d6d610630b3f2db1eeb726acdbb922bdb7557dee08379e1b` |
| `model-sources/release-model-source-lock.json` | `8a229116882465cd3f8356707a0ce31dd71ef6be1c7c260962a5d170e3aa271e` |
| `src/capture_runtime/assets/ocr-profile.json` | `1c6be4a3cebc2b21c33e9c35ee36e07b2bd9fdc86f4c5dde1d224231eb4b77e6` |
| `src/capture_runtime/ocr_vertical_reader.py` | `f1ef46a6b81fa5eb3755df7715eb59c81bde9bb56849e8e66401905b80687d96` |
| `src/capture_runtime/ocr_vertical_routing.py` | `7c6e29ca4d9d92e132e2e3646f885f1a8ccafa829164c1ccc3ac518993b6b550` |
| `dist/release/capture-engine-catalog.json` | `e41ba8aa1079430849c421e9f6dd4848f9e91f86482628e4950df2efd0e78031` |

### Not done

- Publication: nothing is merged to `main`, no workflow was dispatched, no
  registry or release was touched. The model-source tag is the only new ref
  besides the branch.
- Resource measurement was not repeated for the 0.5.0 source; the cached path is
  the candidate 12 path, and the first routed page on a machine additionally
  pays the derivation (about 7 s in one process).
- Consumer migration and gates; unseen-document acceptance; independent review.

## Independent review and unseen-document acceptance (2026-10-06)

Requested by the user before publication. Two read-only review sessions (runtime
code; release source and licences), two blind transcription sessions that read
page images without any OCR output, and runs of the product adapter on documents
not used before. Evidence is under `tmp/vertical-japanese-ocr-phase0/phase1/`
(`accept13-*`, `accept14-*`, `fresh-worker-*-14`, `packaged-semantic-14`).

### Review findings and what was done

| Finding | Action |
| --- | --- |
| **CI would fail**: `mypy` in an environment without the WindowsML extras could not resolve `numpy` and `cv2` imported by the reader | The reader imports both on use through `importlib`, as `ocr_alignment.py` does. Checked in a clean environment: `mypy` passes; unit and integration tests 1,255 passed, 12 skipped |
| Reader tests were all skipped in CI | The cache, file-identity and cascade logic no longer needs numpy and runs in CI. Tests that need arrays (layout order, line clipping, layout failure) still skip there, as the alignment tests do |
| Furigana rule moved ordinary kana-only lines: the end of a sentence above a heading, a kana answer option above a taller option | Two conditions added: a reading's characters take no more width each than the base line is tall, and a kana line as tall as the text line just above it is that text's continuation. Both demonstrated cases are now unchanged and are unit tests. On the gold pages 1,720 of 1,808 furigana characters are set aside (1,732 before), extra body characters 0.83% (0.78%), pages without furigana unchanged |
| Furigana cases not fixed: a small kana label above a kanji line in a form (a "furigana" label above a name field), a small kana tagline above a large title | Recorded limitation: by geometry and script these are furigana |
| Cache: a file was hashed by path and then opened by path | Every model is now created from the bytes that were hashed, for upstream files and cache entries alike |
| Cache: a machine deriving other bytes derived again on every start; another ONNX Runtime release could never match | A marker stops repeated derivation; nothing is derived unless the ONNX Runtime release is the pinned one |
| Cache: temporary files of a killed worker, a failed replace over an open entry, a link in place of the shard directory | Stale temporaries are removed, a failed replace still returns the verified bytes, a linked shard is not used; each has a test |
| Reader load errors other than asset and device errors propagated raw | Mapped to the runtime's unavailable error |
| A line starting left of or above the raster got a wrong right or bottom edge (found by a new test; the detector never returns one) | Fixed |
| PyYAML used but only a transitive dependency | Declared in the `windowsml` extra |
| Routing record counted characters two ways; two guards had no negative test | One counting function; tests for a drifted profile declaration and for the child environment |
| Upstream's dependency-licence file was not delivered; shipped README described delivery wrongly and gave version 1.2 | `LICENCE_DEPENDENCEIES` is pinned in the lock as a second notice (19 OCR files); README corrected, version 1.3.0 |
| Model-sources tag was lightweight | Replaced by an annotated tag on the same commit |

Verified correct by the reviewers and not changed: all upstream URLs serve the
locked bytes; lock, profile and runtime constants agree; installer and catalog
validators accept the new files; `_digraph` equals networkx 3.3 on 3,000 random
graphs and 1,500 `smooth_order` runs; reader steps equal upstream's; no heavy
import at module import time; adapter result consistency.

### Open: licence lineage of the detector weights

**Not resolved, and the user's approval of the model sources did not cover it.**
Upstream publishes the program, with the models in the same repository, under
CC BY 4.0, and lists DEIMv2 and PARSeq as Apache-2.0 in its dependency file.
Its training configuration for the line detector
(`train/deimv2code/part2/configs/ndl_deimv2/deimv2_dinov3_s_coco_r4_800.yml`)
uses a backbone distilled from DINOv3, and the DINOv3 licence is a custom
agreement that covers derivative works and carries use restrictions; upstream's
dependency file has no DINOv3 entry. Whether a distilled, fine-tuned detector is
a derivative work under that agreement is a legal question this work cannot
answer. The specification says unknown licensing invalidates the lock.
Publication should wait for the user's decision.

Also for the user: installs now download about 157 MB from one upstream GitHub
repository at a pinned commit with no mirror; the lock's approval record was
written by the agent on the user's instruction in conversation.

### Unseen documents

**Furigana, two textbooks not used before** (Try N3 and Try N1, 27 sampled pages
through the product adapter): 26 pages have furigana, 373 reading lines moved, no
page routed. Six pages scored against a blind transcription (3,640 body
characters, 645 furigana characters):

| | First pass | Product |
| --- | ---: | ---: |
| Characters in the body that are not in the reference | 602 (16.5%) | 89 (2.4%) |
| Reference body characters missing | 177 | 198 |
| Ordered edit distance of the body | 862 | 375 |

124 furigana characters (19%) were not set aside and 13 characters that are not
furigana were. Better than doing nothing by a wide margin, and weaker than on the
development papers (0.8% extra, none wrongly set aside): textbook layouts with
boxes, tables and contents pages are harder than exam listening pages.

**An N1 paper not used before** (2016-12, 17 pages, no vertical text and no
furigana): every page stays with the regular pipeline and nothing is moved.

**Vertical books from the National Diet Library digital collection** (public
domain, Meiji era; 12 two-page spreads from three books): 11 routed, one kept by
the regular pipeline at a vertical share of 0.77. Six spreads scored against a
blind transcription, with the same pages through the regular pipeline:

| Material | Characters | Reader missed | Regular missed | Reader edits | Regular edits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Printed novels, 4 spreads | 1,792 | 103 (5.7%) | 291 (16.2%) | 277 | 1,070 |
| Handwritten lecture notes, 2 spreads | 1,638 | 277 (16.9%) | 1,037 (63.3%) | 536 | 1,092 |

The reader is clearly better than the regular pipeline on both and is not
accurate on either. Limits of this acceptance: the reference is a second reader,
not adjudicated gold (the transcriber rated one handwritten page low confidence);
Meiji print with old character forms is what the reader was built for and says
little about modern vertical documents, for which no public scans were found;
the pages are few.

### Verification after the review changes

Nx on the runtime: 1,063 unit and 216 integration tests, lint, typecheck. Reader
against upstream on 106 pages: equal on first run, cached, DirectML and with the
cache off. Workers (`verify_fresh_workers_14.py`): pass on CPU, DML and the frozen
worker. Local package journey with the reader installed from the catalog
(19 locked files): 619 boxes equal the source worker. Supplied documents replay:
956 pages, 87 with furigana moved, 733 readings.
