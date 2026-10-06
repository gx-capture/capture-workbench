# Phase 1 product implementation — active

User explicitly requested starting product implementation and verification now,
superseding the earlier requirement to finish Phase 0 before starting Phase 1.
Phase 0 is incomplete; no phase acceptance or publication is asserted.

Product changes: standard-library `ocr_reading_order.py`, integrated after strict
normalization in `WindowsMLOcrAdapter._extract_png_locked`. The same complete
permutation produces text, regions and confidences. The initial candidate preserves
every whole tuple. The current candidate additionally implements the separately
reviewed limited composite exception described below; all other tuples remain exact.
Model, profile and raster are unchanged. Ordering and alignment failures propagate;
cleanup failures retain their actual primary failure stage.

Current status (2026-10-06): candidate **09** is the working tree and, by the
user's decision of 2026-10-06, the stopping point for the reading-order policy.
It keeps the candidate 03 adapter, alignment, composite and lineage modules
byte-identical and revises only `ocr_reading_order.py`. Candidates 04 to 09 were
each reviewed by an independent read-only agent. It passes 983 Python unit tests
(two more are recorded as known limitations), 22 TypeScript tests, 216 integration
tests, lint and typecheck; fresh CPU and DML source workers, the local package
journey and LAW durable readback pass on six pages and 393 boxes.

Scope the user accepted ("not required to be 100% usable"):

- **In scope and stable on every unseen run:** pages that are horizontal with at
  most a boxed vertical passage (the JLPT kind), and horizontal pages staying
  unchanged. Column order inside a band is also stable on dense periodicals.
- **Known not reliable:** the page structure of dense periodical scans, that is
  which columns belong to which page and band, and the order of pages, bands,
  headings and page numbers. Of 11 unseen periodical pages compared with their
  rasters, 7 have an error at that level. See the last section.

Phase 1 implementation is closed (2026-10-06); its gate status is set out item by
item in the [closing section](#2026-10-06--phase-1-closing-status). Phase 1 is not
marked passed: strict Cert semantics fail and the formal gate review has not been
held. The real-page test fixtures hold de-identified
text; evidence in each section binds to the source hashes stated in that section.

The first candidate's verification (hash-bound below; later edits require revalidation):

- Adapter behavior tests first failed on the old left-to-right output, then
  passed after integration. All-horizontal output retains normalized identity.
- Ten real-observation product fixtures cover reviewed p14/2023 p16/2025 p16
  CPU/DML sources and two horizontal pages on both providers. Expected reading
  orders and ruby ownership come from existing independent image bindings,
  never from the new policy.
- First replay passed p14 and 2025, but found the 2023 sidebar between article
  label and body. The policy was corrected without changing allowed gold order.
- Worker tests exercise actual adapter→planner→worker→projection→JSON→parser
  and progress/final equality. The expensive predictor is substituted; these
  tests are not fresh inference or package acceptance.
- Independent Astra review found mixed font sizes incorrectly sharing a scale
  before domain separation (F1), and missing observable ruby-owner relations
  in private diagnostics/tests (F2). Both are repaired and independently closed.
  The frozen review covers seven source/test/fixture hashes and 300 focused tests;
  it explicitly does not approve the complete Phase 1 acceptance gate.

The frozen policy replay (`ccaf99d8169d44eb0939989e1d6df7c7ca25eacd0748813148f20e86fbcc445d`)
matched all six reviewed CPU/DML permutations and ruby sets. Full-page NFKC,
whitespace-free CER was 72.97%→11.39% for p14, 52.27%→5.60% for 2023 p16,
and 47.01%→2.45% for 2025 p16. Both providers had these same values. This is
an ordering-only replay preserving existing recognition errors, not a new OCR
inference or a result over the full corpus. Report SHA256
`2025878c25e00339034785bb782cfee7be7df46956c71b02f09749227f26fb1a`.
Earlier replay records remain historical; this report binds the reviewed source.

Full runtime Nx checks passed on that source: Ruff check/format (168 files), mypy
(88 files), TypeScript typecheck, 783 Python unit tests, 22 TypeScript tests and
216 integration tests. One existing Windows case-distinct-filesystem test was
skipped. Command: `UV_NO_SYNC=1 corepack pnpm nx run-many -t lint typecheck
test-unit test-integration --projects=capture-runtime --parallel=2 --skip-nx-cache`.
After adding four complete-page MEXT fragment fixtures, lint and all unit tests
were repeated: 787 Python tests passed (the same one existing skip), plus all
22 TypeScript tests. The E2E observation-return change also passed typecheck.
All seven independently reviewed same-column body-list fragment pairs, on both
providers, stay adjacent in the same body article and outside ruby. These are
four complete-page inputs with partial relation gold, not complete MEXT page gold.

Fresh canonical CPU and DML runs used the actual source PDF worker on p14, the
2024-07 p2 horizontal control and Bunka p2. All six retain the exact multiset of
text/polygon/confidence tuples and aligned score arrays. Both horizontal outputs
are full-page-object identical to the same-provider Phase 0 output. Both p14
outputs match the reviewed 45-box image order and ruby separators. All six runs
ended without owned worker processes. Bunka tuple conservation does **not** prove
correct reading order: the atomic cross-band composite remains unresolved.

Evidence under `tmp/vertical-japanese-ocr-phase0/`:

| Record | SHA256 |
| --- | --- |
| `reviews/phase1-astra-review-01.json` | `27604402e2aeaec7dc88da3f1136e1d3e04c0165c25600251a4e3a8691c9a905` |
| `phase1/replay-ccaf99d8169d.json` | `2025878c25e00339034785bb782cfee7be7df46956c71b02f09749227f26fb1a` |
| `phase1/fresh-worker-verification-01.json` | `3d7cd26a4bc79f1c2a9fac7894504272f0c7b52d5e4534aeb5e04f51327f5fb4` |
| `reviews/phase1-fresh-astra-review-01.json` | `07999f6799320b6778e13080f9731d7283915be8c1fa114812c03f7f3c53bfcb` |
| `phase1/real-fragments-01.json` | `c3712d328f2a9a978919b30ff8a0ca85e1131055d71f9c76bc2740a413a0e3b8` |
| `phase1/packaged-semantic-01/verification.json` | `f989e0b98a99ae1a3d90e7942e399c6f19b397114c7fdf692875fbf2d6e1be6f` |
| `phase1/law-receipt-readback-01.json` | `ca89cfab62990f789c86e668f29063bfa3133a65ee6007d30c734c05780cd7fc` |
| `reviews/phase1-packaged-astra-review-01.json` | `3c3502cf15013e5c26f55b57604eb83d7797f2067f9afb99ee016b1d8e63313f` |

The source-worker batch alone is not package evidence. A subsequent local package
build and actual HTTP journey installed the newly built OCR worker and processed
the three original pages combined without raster changes. All 202 boxes and all
page texts (including whitespace), polygon coordinates, confidence values and
raster metadata match the same-provider source-worker observations exactly.
Raw segments agree with projected page text. Runtime/worker archive identity,
capture deletion and owned-process cleanup passed the existing shared journey.
The worker PYZ/analysis inventory contains `capture_runtime.ocr_reading_order`.
Runtime SHA256: `f19c2d0839edbaf0a17c20dbb60ca68485587b48b94d6e9b31e0b42f010b26c9`;
worker archive SHA256: `bb1e4a2bed05965febf750f48492da455d35f500503e56f70a127bdfdf70acd5`.
These are locally built candidate bytes, not the published 0.4.4 artifacts despite
retaining that source version. No publication or consumer-host acceptance is claimed.

Build troubleshooting preserved the old four 0.4.3 artifacts in
`phase1/preexisting-engines-0.4.3/` with hashes after assembly rejected their
uncatalogued presence. All dependency builds had passed; assembly-only Nx then
passed. The first local installer attempt rejected an incomplete model-source
directory. The corrected staging directory contains all ten existing catalog-
locked files (same models/profile plus licenses/notices/provenance), verified by
size and SHA256. No product validation was weakened for either failure.

LAW's existing installed Python SDK and durable receipt owners accepted the
actual three-page packaged projection. The local check used native Windows
DPAPI, SQLite and encrypted blob files, closed the store, created fresh key/blob/
database objects and retrieved the terminal by its stored receipt. All 202 boxes,
text (including blank ruby separators), page confidence, raster and provenance
survived exactly; canonical terminal bytes also matched. Isolated temporary
keys/database/blobs were removed. LAW source was unchanged at
`db26fc182e2b6253b78d6a3cd6cc43d4aff5a4a4`. This is real component persistence
evidence, not a Java-engine/HTTP-facade or installed desktop journey.

Limited composite research now has executable evidence: CPU and DML observer
predictions preserve all 120 Bunka raw tuples against both fresh uninstrumented
and retained baselines. Without gold input, neighbor bands, raster whitespace and
the same inference's CTC runs identify one text boundary in the cross-band box.
The candidate partitions the original detector polygon through the observed crop
homography, conserves area and reconstructs the exact original text. Sixteen
controlled alignment/geometry cases pass. This remains a research candidate:
full-page regrouping and independent validation are required before integration.
The proposed inherited child score is not a calibrated child confidence; retaining
the current arithmetic-mean projection would change this page's rounded confidence
from 0.9566 to 0.9567. No product split or confidence rule change is implemented.

The whole-source Bunka replay after that candidate split still failed: the frozen
planner placed part of the left middle band before the remaining upper-band body.
All 108 body columns had unique geometry bindings; the split alone is insufficient.
The second product slice corrects short-column bridging, the band-start
reference and bounded overlap after analysis deskew. It also preserves original
Paddle result/region slots through strict normalization and the private plan;
normalized ordinals alone must not identify raw slots after empty crops are dropped.
Neither slice is covered by the first candidate's approval or package run.

This second slice passed all four runtime Nx targets: 803 Python unit tests,
22 TypeScript tests and 216 integration tests; the same existing Windows-only
case-distinct-filesystem test was skipped. Ruff checked/formatted 168 files and
mypy checked 88 files; TypeScript typecheck passed. The validated reading-order
module was `7dbe4d89f6d85e342a6b911f11199f1661e357d3834f14cab0cac68160b152c1`,
adapter `478bbc38a4b59a7a7b431a17c7079e050495445349712094e2bf290862aa92ef`,
and normalization tests
`cfa727f03ef9b323fc1c0d9cd0b6c7a9fdcc01d92f72c34e31e247d0024ad6da`.
The private original `(result slot, region slot)` identity survives empty-region
filtering and the emitted permutation; no public page/box fields were added.

With the research split supplied, both complete 121-region Bunka replays now put
all 108 body columns in image order across six bands. This is conditional replay,
not a runtime split: four author frames still precede the body, and incomplete
non-body bindings remain. Replay summary SHA256:
`f62ae105c82c8c4cbe2ccde022f2c5c35631e02902bd5b00fffc9d223f023363`.
The next slice addresses author ownership and independently reviews the same-
inference alignment collector before any limited split changes runtime output.

That subsequent slice is now implemented in the actual adapter. Private
`ocr_alignment.py` observes one existing inference using instance-owned hooks;
`ocr_composite_regions.py` accepts only agreeing local-band, actual-raster-whitespace
and CTC evidence; `ocr_region_lineage.py` checks complete parent/span conservation.
No second model call, new public field, model or profile is introduced. The private
layout evidence retains parent tuples and emitted raw-slot/span identities. A
canonical alignment contract/execution failure fails the job; insufficient valid
split evidence keeps its whole parent without satisfying a mandatory split case.

The initial collector and ledger reviews found restore-error masking (F5) and
overrestricting unchanged polygons (F6). Both were independently reproduced and
closed after fixes: cleanup attempts every undo while preserving the primary
exception; convex/partition requirements apply only to split geometry. The pure
policy additionally rejects blank-only children, CTC tokens supported only by model
padding, reversed vertical text axes, incompatible font scales, remote or disjoint
neighbor domains, and unsupported nonconvex parents. Short columns can bridge a
normal local pitch; a large gutter cannot supply cross-band evidence.

The second composite source snapshot passed all four Nx targets: **884 Python unit
tests**, **22 TypeScript tests**, **216 integration tests**, Ruff check/format on
175 files, mypy on 91 source files and TypeScript typecheck. One existing Windows
case-distinct-filesystem test was skipped; all 14 alignment pixel cases ran with
the installed OCR extras. No failed case was retried into an acceptance claim.

| Historical composite candidate 02 source | SHA256 |
| --- | --- |
| `engine_adapters.py` | `6be5436a99383400ceebfdf90405baf9b2bd14b491ad405423da5c7b53dcb406` |
| `ocr_reading_order.py` | `9bdaad08d974e6fb30253bd7e480f551626783de71be4b040474fa0a4ce55a38` |
| `ocr_alignment.py` | `261f519f68ff61649468e63e6295ccb79e5d71a58fcc0298ba52235379e00484` |
| `ocr_composite_regions.py` | `c8c86fe2b52c6e4135eb805a55f431276605795c1ac54458b1e558667856dd3a` |
| `ocr_region_lineage.py` | `04c7de729666641eaae2e5e618000af62469decee27ba5c10b88b12f80848774` |

A portable regression contains complete CPU/DML observations and scalar alignment
for Bunka (120 source tuples each), without images or logits. It verifies 121 emitted
frames, all 108 reviewed body relations and the four author frames after the body.
The author owner no longer crosses a horizontal divider that overlaps a band edge
slightly (independent F4, closed). Fixture SHA256:
`dcfe45bad217ea80b808d66a750ac650a484db0339c9a09e3c0f119ee59e4ca5`.
It explicitly remains partial image gold. Candidate 02 completed fresh CPU/DML
worker checks: 37 horizontal-control boxes, 45 p14 boxes and 121 Bunka boxes for
each provider. Independent strict verification checked source/baseline artifact
hashes, full horizontal identity, p14 order/ruby formatting and exact tuple scores.
Bunka retains 119 parents unchanged and partitions one parent into two children;
all 108 reviewed body spans precede the four authors. Eleven injected faults were
rejected. Report SHA256:
`193247cddd54a0c8ed5118839b837fe6fbd2dfd7c6b3c4676957d292278f8d82`.
Worker page confidence remains null. The 0.9566 to 0.9567 change is the derived
arithmetic aggregate, not an emitted worker page score. Neither the old packaged
run nor old LAW readback verifies these newly integrated split bytes.

Candidate 03 adds two compatibility fixes: children with edge whitespace remain
unsplit because existing serialization trims box edges; optional pixel dependencies
are loaded only inside the collector so the base environment still typechecks.
The former has two red-to-green cases; the latter reproduced two missing-import
errors in an isolated base environment before the fix. Models/profile are unchanged.
Its source hashes differ from candidate 02 only for `ocr_composite_regions.py`
(`e146872d5a02dd1fbcd141dc62bb07aca8b6664aeba833323884a3c0d39fbc3d`)
and `ocr_alignment.py`
(`4e76ee345d7da65376cd55c032203eb25c93b7b5abefeec99a7cd2759642deb8`).
All four Nx targets passed again: **886 Python unit tests**, **22 TypeScript tests**,
**216 integration tests**, Ruff on 175 files, mypy on 91 source files and TypeScript
typecheck. The sole skip remains the pre-existing Windows case-distinct path test;
all 14 pixel/alignment cases ran. Independent source review found no remaining
proven blocker in this bounded source scope. Review SHA256:
`b152cc3139a4800b30c2ba67f1a33af1436c3fad2c7683e74408fe987d909208`.
Fresh worker and local package verification must bind to this new snapshot.

Candidate 03 fresh CPU/DML workers have now completed the same three pages each.
The strict verifier again passes complete horizontal identity, p14 article/ruby
order, Bunka parent/span and geometry conservation, 108 reviewed body spans and
four authors after the body. It checks all live snapshot hashes before and after
verification and rejects eleven injected faults. Report SHA256:
`1428bd5566ab2f6966ccf5b101a750638b5535d14a84e0ec1d6ff65d25cda93f`.
This remains a three-page source-worker check with partial Bunka gold, not a
complete-corpus, resource-budget or packaged-product acceptance claim.

Independent Astra Ultra review of fresh candidate 03 also passed this bounded
evidence scope. Report SHA256:
`715a151edd7f4a6304d6ff30c6588873f5d964ec85947b5d1ab9173df13bb668`.
The complete local build then passed all eleven Nx tasks, including worker/core
boundaries. The built worker PYZ contains all four new modules. A new real HTTP
journey installed that worker and processed the same three original PDF pages:
all **203** boxes, strings including whitespace, polygons, confidence values,
raster metadata and provenance exactly match source-worker DML03. Raw segments
also match projected text; capture deletion and owned-process cleanup passed.
Package verification SHA256:
`f3d813e0ae8ece3ebbdaac8a7785fa7a455b311bd6d5eec4799b230dac263c2b`.

LAW then saved this actual package02 projection using its unchanged SDK and
SQLite/Windows-DPAPI/encrypted-blob owners. Fresh store/key/blob objects recovered
all three pages and **203** boxes exactly, including text, page confidence and
provenance. Temporary durable state was removed. Readback report SHA256:
`94fc4362a850ed843abfb4a3a8daae084dd830280c8057c68efc6ba1c2973e2b`.
This is real local persistence-component evidence, not a LAW host UI or Java/HTTP
facade journey. Independent package/readback review is pending.

The current source and local artifact candidate are preserved separately in
`phase1/candidate-composite-03/`: 102 source files and fourteen release files,
all individually hash-checked after copying. Manifest SHA256:
`2189194c25b7b25d84a2da303852da6a03379cd21986afd073f9ee519117101f`.
It records the exact package evidence and retains `phasePass=false`,
`published=false`. No release/profile/model version was changed.

Cert's independent final narrow review closed seven demonstrated parser defects:
decimal splitting, quantity-as-question, undecorated-number footer deletion,
kana-paragraph deletion, bare subject-name deletion, persisted global chunk-index
handling, and a sentence beginning with a question-reference token. The final
formal replay restores questions 55–59 on the studied continuation pair, but only
question 59 passes all strict choices. This is not a semantic-gold or phase PASS.
Cert's final unit/lint checks passed (151 unit tests), while full integration has
235 passing tests and one failed practice-attempt-history ordering case outside
the parser slice. That failure is recorded as unresolved, not relabeled a passing
target. Final parser review SHA256:
`f7b24d78eb3a00f9408ae4dd5223ff212504757d48fd694ad010a9a1c8e6f798`.
Geometry is available at validated projection ingress and is absent from durable
document chunks; a later parser cannot safely infer ruby/footer roles from text
alone. Any durable geometry context must be explicit and traceable, not a rewrite
of stored raw text. Geometry trace SHA256:
`c12f24c0c0efe6427454fce3cc0bf9d190603b0d2d5d82cf1c136a5ce6bbc4f7`.

The first candidate remains independently reproducible in
`phase1/candidate-whole-region-01/`: all fourteen local release files plus the
matching runtime source snapshot are retained. Candidate manifest SHA256:
`5f17822e1f9d513b35e0beddb9a9bfc6d29f8a061bf702e3ae4e4cb9ff684bfa`.
It remains `phasePass=false` and is not a release authorization.

Acceptance gaps stay open: complete Bunka non-body gold, remaining mixed-layout
cases, full consumer validation, warm-p95 resources and unseen inputs. The studied
Bunka cross-band parent now splits in the actual worker; this bounded success does
not establish general composite coverage or a phase PASS.
Cert parser compatibility work is active in its existing domain owner; direct
parser improvements do not substitute for the formal extraction entry point.

Important review finding F3: the agent now authoring the product module previously
acted as the private holdout image reader/custodian. Therefore those documents are
already exposed to this policy author and **cannot count as unseen acceptance**,
even if no private content is sent to Root or deliberately used for tuning.
Root accepts this role-allocation error. Original private evidence is retained;
future unseen acceptance requires new full documents and custody separated from
all policy authors. This does not stop the newly authorized implementation, and
does not justify claiming the existing reserved documents passed an unseen gate.

## 2026-10-04 — candidate 04: reading-order policy revision

Author: Claude Opus 5.5 in one session, without a second reviewer. Nothing in this
section is an independent review, a gate result or a release authorization.

### How the gaps were found

The 24 rendered synthetic variants have a renderer glyph ledger (position, block,
ruby and signature flag, ruby-to-base link for every glyph). Binding each retained
OCR region to the glyphs whose centers it contains gives a whole-region order, ruby
set and ruby owner that do not depend on any policy output. The reference order is
the one already used for the Phase 0 synthetic CER: DOM block order, and per
vertical block body, signature, ruby. All 48 CPU/DML observations bind without an
uncovered region or an order contradiction. Candidate 03 matched this order on
16 of 48; on every other vertical page it missed by one to four regions.

The retained real vertical pages have no gold for most layouts, so a geometric
proxy was used: two long columns that share a band top and are horizontal
neighbours must be emitted right before left. It cannot see band, article or page
mistakes; it only finds columns that left their article. Two facing-page scans
were also compared with their rasters by eye (Bunka p4 and 文部時報 1277 p5).

### Defects and changes in `ocr_reading_order.py`

1. **Dense small type.** A body column whose detector box was narrower than 0.85
   of the article scale was not attached to its article. It stayed a loose unit
   and was emitted before or after the whole article. On the 18 affected retained
   DML pages candidate 04 places 106 more regions in an article body than
   candidate 03 did, 88 of them long columns (a gross count: one-column groups
   that stopped being articles lower the net change to 14). A box of 0.6 to 0.85 scale is
   now body when it fills its own lane, that is when it does not sit against a
   left neighbour the way ruby does.
2. **Ruby width.** Detector padding widens a ruby box into its owner, so a width
   limit of 0.7 scale rejected real ruby by one pixel. Ruby is now also accepted
   when it is narrower than a body column and its right edge reaches at most 0.7
   scale past the right edge of the owner. Text without kana must overlap the owner
   and reach at most 0.6 scale, which contains the previous rule.
3. **Signature.** A source line had to start in the lower half of the band. A long
   bottom-aligned one starts higher, was left loose and was emitted after the ruby
   of its article. It is now a signature when it is indented by two em and either
   starts in the lower half or ends within 1.5 em of the band bottom.
4. **Band founded by ruby.** A long ruby and an indented signature formed a second
   band with one body column. A spatial group now needs two columns of its own
   scale to become an article.
5. **Page furniture.** A small header in a page corner became a page-level column
   and was emitted last. When all articles of the current region lie in one
   x-domain, rows wholly above or below them are read before and after them.
   Several article domains (facing pages) keep the header and number of each page.
6. **Facing pages that lean differently.** One scan of two pages with different
   skew failed the consistency guard and kept detector order (Bunka p4, 文化庁月報
   117 p4, 文部時報 1277 p5 and p6). The pages are now separated at the widest gap
   between long lines, which must be at least three column widths, and each side
   is analysed in its own frame when both sides are consistent alone. Otherwise the
   guard still returns the input order. Polygons are not modified.

Fifteen new unit cases cover these rules; seven of them fail on candidate 03. The
other eight are guards that pass on both (ruby at a column top, text that
stands clear of its owner, facing pages with their own headers, side questions
beside stacked articles, inconsistent skew without a gutter).

### Results

Synthetic full-text CER, six pages per variant, 2,941 reference characters, same
values for CPU and DML. "Ledger order" is the lower bound for any whole-region
permutation of the same recognition output:

| Variant | Baseline | Candidate 03 | Candidate 04 | Ledger order |
| --- | ---: | ---: | ---: | ---: |
| clean | 54.61% | 5.98% | 4.52% | 4.52% |
| scan | 54.47% | 3.30% | 2.07% | 2.07% |
| +0.8° | 54.20% | 2.96% | 1.73% | 1.73% |
| −1.5° | 55.02% | 12.95% | 11.32% | 11.32% |

Candidate 04 matches the ledger order, ruby set and ruby owners on 48 of 48. What
remains is recognition: at −1.5° one page loses five long columns to the
recognizer (296 of its 406 characters), which no ordering can repair.

Retained real pages, 414 observations (176 development pages on both providers and
62 supplementary DML pages): 27 changed, applied pages 65 to 70. Neighbouring
columns emitted left before right fell from 642 to 9; neighbours emitted in the
right direction but not consecutively fell from 207 to 77. Of the 642, 566 come from
the five facing-page observations candidate 03 did not apply at all; on pages both
candidates applied the fall is 76 to 9 (and 129 to 62 for the second count). The nine remaining
inversions are a colophon (Bunka p6, both providers), a contents page (1277 p1) and
a two-column heading (117 p10). Reviewed pages p14, 2023 p16, 2025 p16, Bunka p2
and both horizontal controls are unchanged. 2024-07 p16, which has an image
transcription but no source binding, scores 48.20% before and 5.82% after against
that transcription; its remaining edits are dropped punctuation, small kana and
one option marker.

Bunka p4 and 1277 p5 read correctly against their rasters: right page first, bands
top to bottom, columns right to left, separators in place. The Bunka p4 fixture
asserts only the relative order of its 136 body columns, built from page and band
boundaries read off the raster by one reader.

### Verification of this source

All four Nx targets pass without cache: Ruff check and format on 175 files, mypy
on 91 source files, TypeScript typecheck, **951 Python unit tests**, **22
TypeScript tests** and **216 integration tests**. The one skip is the existing
Windows case-distinct-filesystem test. Command: `UV_NO_SYNC=1 corepack pnpm nx
run-many -t lint typecheck test-unit test-integration --projects=capture-runtime
--parallel=2 --skip-nx-cache`.

Fresh inference used the same source-worker probe as candidate 03 (version v7),
once per page on each provider, with the source snapshot of each run equal to the
live tree. The verifier reads artifacts only. Both providers: the horizontal
control is identical in order and text to its reviewed baseline; p14, 2023 p16 and
2025 p16 are in a reviewed allowed order with exact ruby separators; Bunka p2 emits
121 boxes in exactly the candidate 03 sequence of text and polygon (scores are
compared and reported, zero differ, but equality is not enforced); Bunka p4
keeps the baseline tuple multiset and the reviewed body order, which the Phase 0
baseline does not satisfy. Scores stay aligned with boxes and the worker page
confidence stays null. Seven injected faults are rejected.

The complete local build passed all eleven Nx tasks. The real HTTP journey then
installed the newly built OCR worker and processed the six original pages as one
PDF: all **393** boxes, strings including whitespace, polygons, confidence values,
raster metadata and provenance equal the source-worker DML observations. Capture
deletion and owned-process cleanup passed. Because Bunka p4 differs from
candidate 03 only through the revised policy, the equality also shows the
installed worker contains the revised module. Runtime SHA256
`6cfbf07e343aa76a10e1082c72bf080ac0d51ab15a4969a3fd76e7876625d1b0`; worker archive
SHA256 `d9c52b425978cb229bacb3f79a2ce553433a19af272d0a352f39a0fd821f2e9f`. These
are local candidate bytes that keep source version 0.4.4; nothing was published.

LAW then saved this packaged projection with its unchanged SDK and SQLite, Windows
DPAPI and encrypted-blob owners (LAW source `db26fc182e2b6253b78d6a3cd6cc43d4aff5a4a4`).
After closing the store, fresh store, key and blob objects recovered all six pages
and **393** boxes exactly, including text, page confidence, raster and provenance;
canonical terminal bytes matched and the temporary durable state was removed. This
is local persistence-component evidence, not a LAW host UI or Java/HTTP journey.

| Candidate 04 source or fixture | SHA256 |
| --- | --- |
| `ocr_reading_order.py` | `5b4635082c57d0eb3983b2f4f06d17a1164189cbdc1d679a579f4a78e785715a` |
| `reading-order-synthetic-pages.json` | `aea823d1966731ff5bdb2b43f14415a6d5f52f3828d3af673cf79dbf1feac303` |
| `reading-order-facing-pages.json` | `46558bbea5686558bff90f1d2dbdc157566ba2c6e04b610dbbb365724144749e` |

Evidence under `tmp/vertical-japanese-ocr-phase0/phase1/`:

| Record | SHA256 |
| --- | --- |
| `replay-candidate-04-5b4635082c57.json` | `8ab4387218ba6616a09ef457495497998d24899c82f64666b63aee4a1133668f` |
| `fresh-worker-dml-04/completed.json` | `51891084c90a669c0ae0423240c599c09b3bb8e1c7f6482b2101c16706f1813e` |
| `fresh-worker-cpu-04/completed.json` | `520f7f745433b9ff2f0db5d4c978895e993bba47f55fb02e46bea9eed966557f` |
| `fresh-worker-verification-04.json` | `d6e49487451efb18b812475206c31ef48a6eab5986750325e2492ddcd2afcb6d` |
| `packaged-semantic-04/verification.json` | `f76f8519b5581fef6aad50067e7db17b990c09979b75894352eed411df0ebc6b` |
| `law-receipt-readback-04.json` | `529656e6bb883748cb242413813ac796e895214d16e042811332b4b8d070100c` |
| `candidate-reading-order-04/manifest.json` | `bfefee37d98f3e7beef8f576b44503a6bc53a84766b2066ecba0105cb91c01eb` |

The helpers are `export_synthetic_order_fixture.py`, `export_facing_page_fixture.py`,
`measure_candidate_04.py`, `verify_fresh_workers_04.py`, `prepare_package_pdf_04.py`,
`verify_local_package_04.mts` and `verify_law_receipt_04.py` in the same directory. The candidate directory
holds 102 source files and the fourteen local release files, each hash-checked
against the live tree after copying, with `phasePass=false` and `published=false`.

The 2023 N1 p16 fresh run of 2026-10-02 (`fresh-worker-2023p16-verification-01.json`,
both providers, scoped PASS with seven rejected faults) used candidate 03 source.
Candidate 04 repeats that page in the six-page run above.

### Open after candidate 04

- Independent review of the revised policy, its fixtures and the three evidence
  reports. The synthetic order is a generated reference and the Bunka p4 body order
  is a single-reader relation; neither is double-read image gold.
- Cert strict semantics, unseen complete documents, warm-p95 resources and
  complete Bunka and MEXT page gold.
- Layouts the policy still orders poorly on retained pages: contents pages,
  colophons, a heading set in two columns beside body text, and names set as
  spaced single characters (文部時報 1277 p13 orders two such pairs bottom-up).
- With several article domains a footer below all of them is still emitted with
  the page it stands under, before the articles of the next page (MEXT 2019-07 p33).
- Recognition on vertical text drops punctuation and small kana and fails on some
  long columns at −1.5°. That is outside reading order and belongs to Phases 2 and 3.

## 2026-10-04 — candidate 05: review findings and unseen document

Author: Claude Opus 5.5. The review below was done by a separate read-only agent in
the same session, with no access to edit the repository. It is a bounded review of
candidate 04, not a phase gate, and it has not seen the candidate 05 changes.

### Independent review of candidate 04

The reviewer reran the two idempotent verifiers (reports byte-identical), re-derived
the synthetic expected order from the glyph ledgers by a different binding method
(48 of 48 identical in order, ruby and owners), checked the Bunka p4 page and band
boundaries against the raster, and recounted the numeric claims. All matched. It
found no enumeration dependence, no mutation of regions, intact guards and a
terminating unit loop. Its defects, each reproduced with a minimal input:

1. **Real regression.** The narrow-column rule also applied to same-lane
   continuations, so a page number under a column became body and was emitted in
   mid-sentence: six page numbers on four retained pages (文化庁月報 117 p5, p9,
   p11, p12). Candidate 03 left them at the page end.
2. A ruby on the first characters of a column that stands clear of its owner became
   a body column.
3. A block with a single long column beside another article lost its article and
   its ruby.
4. A horizontal block beside the articles that starts above their top was split by
   the page-furniture rule.
5. A vertical page facing a horizontal-only page had both pages' headers and page
   numbers merged.

It also noted that the synthetic fixture is the set the policy was tuned on (a
regression guard, not a holdout), that the measurement did not check ruby owners,
and that the neighbour proxy and the Bunka p4 fixture cannot see misplaced page
numbers or separators.

### Unseen document

The user supplied one document that no policy author had seen: a 44-page scanned
Chinese labour-case file (official letters, forms, tables, stamps, redactions,
printed web forms), all horizontal. It is not vertical Japanese; it tests that
non-vertical pages keep their output. It was run in process on CPU through the
adapter's own steps (same-inference alignment, composite planning, reading order),
3,434 regions in total. Its content stays in the ignored evidence folder.

Candidate 04: 43 pages identical to the normalized input, no splits. Page 44, a
landscape table scanned sideways, was treated as vertical and 206 of its 220 boxes
moved. Candidate 03 does the same on the retained regions, so this predates
candidate 04. On that page 4% of the characters in tall boxes are kana or
ideographs; on every retained vertical page the share is at least 60%.

### Changes in candidate 05

- The narrow-column rule applies only at the band top, never to number labels, and
  asks whether the box stands a lane away from the column on its left (at least
  0.75 of the closest anchor spacing) instead of measuring its reach. Ruby at a
  column top stays ruby. Number labels inside article bodies are back to the
  candidate 03 count (3 across the retained observations, all full-width).
- The two-column requirement moved from each spatial group to the band, so a
  single-column block in a real band keeps its article and ruby, and a long ruby
  beside an indented signature still founds nothing.
- Page furniture is peeled only when it shares no x-range with loose text beside
  the articles, row by row from the page edge.
- A page is vertical only if at least two long boxes contain kana or ideographs.
  A sideways page of Chinese or Japanese prose would still pass this test; that
  needs page-orientation detection and is not attempted.

Seven new unit cases cover the five review findings and the sideways scan; six of
them fail on candidate 04. One earlier toy case was rebuilt with enough columns to
have a real lane spacing.

### Results and verification

Synthetic pages: still 48 of 48 on order, ruby set and ruby owners, with the same
CER table as candidate 04. Retained real pages (414 observations): 22 changed
against candidate 03, applied pages 65 to 70, inversions 642 to 9 overall and 76
to 9 on pages both apply, not-consecutive neighbours 207 to 69 overall and 129 to
62 on pages both apply. The six fresh pages are box-for-box identical between
candidates 04 and 05 on CPU. The unseen document: 44 of 44 pages identical.

All four Nx targets pass without cache: **958 Python unit tests** (one existing
skip), **22 TypeScript tests**, **216 integration tests**, Ruff on 175 files, mypy
on 91 source files and TypeScript typecheck. Fresh CPU and DML source workers pass
the same strict verifier on the same six pages with seven injected faults rejected.
The rebuilt local package reproduces all **393** boxes over the real HTTP path, and
LAW durable readback (unchanged LAW source `db26fc182e2b6253b78d6a3cd6cc43d4aff5a4a4`)
returns them unchanged. Runtime SHA256
`569e3066a4d5779d14911f9236dced32262d964627b894ab9686904a51b80675`; worker archive
SHA256 `5e18664c8a7ef8173768ca04346bce23facd94bb739aa9842749d174a0a5d4d0`. Local
candidate bytes with source version 0.4.4; nothing was published.

| Candidate 05 source or record | SHA256 |
| --- | --- |
| `ocr_reading_order.py` | `2eaea4e0ab3db92f6170f8a332b6a5010037197f3ccac6f7b6852e8d420abe84` |
| `replay-candidate-05-2eaea4e0ab3d.json` | `73afe013f9e00d20191c4bdf7f443efdd690c274198d19219e415c75194042ac` |
| `fresh-worker-dml-05/completed.json` | `157384ed4eec46e003d8b5b0c890a7cbc171d5e991e4036a8c7e8dc071d46f93` |
| `fresh-worker-cpu-05/completed.json` | `d00236469fc326c475d3e9fa19418abc1734d312d7f9f07636ca47080aac877e` |
| `fresh-worker-verification-05.json` | `dea9aa24dc55c8d620ccbdf3b502d4738185eb2fa2fe4518e8b8c9cf12bf0a4e` |
| `packaged-semantic-05/verification.json` | `33c5028fda2c21e3900821e32ab37a9d2ca3c957b49787d0765d9280e001f11c` |
| `law-receipt-readback-05.json` | `fbf4f61caed75cba1e32b251cd2d94b4288ac46d744f5c6d970c37c9bab29215` |
| `unseen-zh-01/summary.json` | `50a357542ff11343282c2132ca6c6d23ef01b53fff795888eff6b93c0aca4e54` |
| `candidate-reading-order-05/manifest.json` | `2faed0a00bab80841ee448d39dfe557c66c753851716cd9b602073ae8f628d2a` |

Records and their `_05` helpers are under `tmp/vertical-japanese-ocr-phase0/phase1/`;
the unseen run is `run_unseen_zh_01.py`, and `unseen-zh-01/summary-candidate-04.json`
keeps the candidate 04 result.

### Open after candidate 05

- Independent review of the candidate 05 changes.
- An unseen vertical Japanese document. The four N1 PDFs kept in the Cert repository
  are byte-identical to the frozen development documents, and the supplied unseen
  document is horizontal Chinese, so this gate has no evidence yet.
- Cert strict semantics, warm-p95 resources, complete Bunka and MEXT page gold.
- Poorly ordered layouts listed after candidate 04 (contents pages, colophons,
  two-column headings, spaced names) and the footer of a multi-domain page are
  unchanged. Sideways pages keep their input order but are not recognized usefully.
- `ReadingPlan.skew_degrees` reports the rejected page-wide median on facing pages;
  nothing reads it today.

## 2026-10-05 — candidate 06: second review and unseen vertical pages

Author: Claude Opus 5.5. The review of candidate 05 was done by a second read-only
agent that could not edit the repository and was told not to open the unseen
material. It has not seen candidate 06.

### Independent review of candidate 05

No contract defect: complete permutations, exact input for unapplied pages, intact
guards, no enumeration dependence, terminating loops; all nine record hashes and
the replay numbers matched on rerun. Of the five candidate 04 findings it judged
three fixed, one fixed only for narrow page numbers and one only for small gaps.
But candidate 05 was **worse than candidate 04 on five retained pages**, which the
candidate 05 section above did not say:

1. Moving the two-column rule to the band let any lone long box found an article
   when unrelated columns shared its top: a fragment under a name (MEXT 2019-07
   p24, p27) and a large title that adopted horizontal name lines (文部時報 1277 p2).
2. The lane spacing taken from the closest anchors was two lanes wide when the
   anchors straddled a narrow column, so that column was emitted before its right
   neighbour (Bunka p1, both providers). The unchanged total of nine inversions hid
   it: Bunka p1 went from 0 to 1 while Bunka p6 went from 3 to 2.
3. The unit case for exactly that situation had been rebuilt with an extra column
   so that it passed. The original four-column case is restored and passes on
   candidate 06.
4. Narrow fragments under a column were no longer continuations (1277 p1, Bunka p6).

Notes: page numbers at least 0.85 em wide or decorated (`- 18 -`) were still taken
as continuations (same in candidate 03); a top ruby beside the rightmost column
with a gap of 0.3 to 0.5 em was still body; the furniture test flipped on a
one-pixel overlap; the script gate was one box from failing; the six fresh pages are
identical between candidates 04 and 05, so the fresh, packaged and LAW evidence
exercised none of the candidate 05 rule changes; and a unit test contained an
amount that occurs on the private unseen page. That value has been replaced.

### Unseen N1 papers

The user supplied a folder of N1 papers. Seven question papers were chosen by name
before any content was read, none of them a development or reserved document, and
run in process on CPU with the committed candidate 05 policy:

| Paper | Pages | Regions | Pages left unchanged | Vertical pages |
| --- | ---: | ---: | ---: | --- |
| 2011-12, 2014-07, 2017-07 | 47 | 2,673 | 47 | none |
| 2021-07, 2023-07 | 28 | 1,457 | 28 | none |
| 2022-07 | 15 | 728 | 14 | p6 |
| 2022-12 | 16 | 746 | 15 | p6 |

The two vertical pages hold horizontal questions around one boxed vertical passage.
Compared with the rasters by one reader, the passage itself was right on both (8
and 11 columns, right to left). Both pages had the same defect, absent from every
development page: the bare option numbers `3` and `4` of the question above the
passage were taken as passage labels, which pulled the last options out of order.
These two pages informed candidate 06 and are regression inputs now
(`reading-order-mixed-pages.json`); the second supplied folder has not been opened
and stays available as unseen material.

### Changes in candidate 06

- A passage label is a letter or a bracketed number; a bare number is not.
- One long box is an article only when it stands outside the reach of every article
  with two or more columns. Inside that reach it is left to the signature,
  continuation and body rules. This keeps an isolated single column with its ruby
  and stops fragments, signatures and headings from founding articles.
- Lane spacing is the median spacing of all band-top columns including narrow ones
  when at least three spacings exist, and the closest anchor pair otherwise. A long
  narrow box at the band top is a column whatever the spacing. The threshold is
  0.85 of the lane.
- Narrow fragments under a column continue it again, unless they are numbers,
  decorated page numbers or label-like.
- Body and signature boxes must be upright (height at least 0.75 of width), so a
  wide title cannot adopt horizontal lines.
- The furniture test needs an overlap of a quarter of the narrower unit.
- A page is vertical only if at least two long boxes and at least half of them
  contain kana or ideographs; such a page reports its own diagnostic.

Known and not fixed: a top ruby standing well clear of the rightmost column of a
band with few columns is still ambiguous; on 2022-07 p6 two footnotes beside the
boxed passage are emitted before it; a header row holding both a corner header and
a line above side questions is not peeled.

### Results and verification

Every assertion of the candidate 04 test file (62 cases) and of the candidate 05
test file (69 cases) passes on candidate 06; twelve further cases cover the items
above. Synthetic pages: 48 of 48 on order, ruby set and ruby owners, same CER
table. Retained real pages (414 observations): 27 changed against candidate 03,
applied 65 to 70, inversions 642 to 7 overall and 76 to 7 on pages both apply,
not-consecutive neighbours 207 to 67 and 129 to 60, number labels inside article
bodies 3 to 1. Against candidate 04, MEXT p24 and p27 and 1277 p1 and p13 are
identical again; the four 文化庁月報 117 pages keep the candidate 05 page-number
fix; 117 p7 and 1277 p9 additionally lose a full-width page number from mid-body;
1277 p2 lists its participants in order with the title as a single-column article.
Bunka p1 and p6 (contents page and colophon) differ from every earlier candidate
and were not judged against their rasters.

Supplied unseen documents, replayed with candidate 06 over the stored regions:
all 104 horizontal N1 pages and all 44 pages of the Chinese case file are unchanged;
2022-07 p6 and 2022-12 p6 are applied with one label, the passage in order and
every line above the passage in input order.

All four Nx targets pass without cache: **970 Python unit tests** (one existing
skip), **22 TypeScript tests**, **216 integration tests**, Ruff on 175 files, mypy
on 91 source files and TypeScript typecheck. Fresh CPU and DML source workers pass
the strict verifier on the six pages with seven injected faults rejected; the
rebuilt local package reproduces all **393** boxes over the real HTTP path; LAW
durable readback returns them unchanged. As the reviewer observed for candidate 05,
these six pages do not exercise the candidate 06 rule changes: they show that the
revised module is what runs in the worker and the package and that reviewed pages
did not move. Runtime SHA256
`3c1ba7302295d56fd8f0fa7c76b07582e8626e89f96dfd1d2895814f31b64db8`; worker archive
SHA256 `661c304f83228947f56b820efb0c4c39a61379d34b1de7caad75c5a145cb14af`. Local
candidate bytes with source version 0.4.4; nothing was published.

| Candidate 06 source or record | SHA256 |
| --- | --- |
| `ocr_reading_order.py` | `f1f4aa1ad6dcd574f9552812f5d8ca8c4a27da4c6677666096f9e80d47f84c30` |
| `reading-order-mixed-pages.json` | `7765a4fa10695c1748517f3185b149f0139f578759f8266e5c67017981921a9d` |
| `replay-candidate-06-f1f4aa1ad6dc.json` | `3ae85f924ccf12bacc7e0887288da8ecae2ce7bf8a64197921e28606df615304` |
| `unseen-replay-candidate-06.json` | `9d90990e8349d6ad0c5ef6b8307c36cf41d261d23396e870a89b497787a6e06c` |
| `fresh-worker-dml-06/completed.json` | `5adf8a201abe5ef828ac115b79eb5146d2f3f3fdf5ababa826853eb410bd402f` |
| `fresh-worker-cpu-06/completed.json` | `2e749af07401cfea3ccb57ffe2a24b50537d15705d7621ada463f4efc18b2312` |
| `fresh-worker-verification-06.json` | `42091a3454a1084fcac40313f1ec1d57a4809969f6527a7f64a3dfddc1650636` |
| `packaged-semantic-06/verification.json` | `6fe8a4ed5e31aaccf0c391cf2780acae47798eba92f44847104b0b8c64af6905` |
| `law-receipt-readback-06.json` | `7aad47ec315a0c6f9e9bd5daeb12ad61bfc2d4c0abc1719f07808b901169877a` |
| `candidate-reading-order-06/manifest.json` | `fc6cbc4c36dae68744191de7870a7829907c4059bbd5b4ea9efebb6b45949579` |

Records and `_06` helpers are under `tmp/vertical-japanese-ocr-phase0/phase1/`; the
unseen runs are `run_unseen_doc.py` with one `unseen-*` folder per document.

### Open after candidate 06

- Independent review of candidate 06. Two rounds of fixes each introduced
  regressions that only a reviewer or unseen pages caught, so this one should be
  assumed to have some too.
- An unseen vertical page run against candidate 06 (the second supplied folder is
  untouched), Cert strict semantics, warm-p95 resources, complete page gold.
- Contents pages, colophons, two-column headings, spaced names, footers on
  multi-domain pages and footnotes beside a boxed passage remain poorly ordered.

## 2026-10-05 — candidate 07: third review, held-out run and step back

Author: Claude Opus 5.5, on the user's choice to converge rather than fix another
round. The review of candidate 06 was done by a third read-only agent. It has not
seen candidate 07.

### Independent review of candidate 06

Contract and evidence held; every hash and number reproduced except one page count
in the candidate 06 section (104 horizontal N1 pages, not 119; corrected above).
The candidate 05 regressions on MEXT p24 and p27 and 1277 p1, p2 and p13 were gone,
and 1277 p2, 1277 p9 and 117 p7 were better than in every earlier candidate. Of the
two formerly unseen pages, 2022-12 p6 matched its raster on all 46 regions and
2022-07 p6 on all but three (two footnotes and a stray fragment emitted between the
question above the passage and the passage label). New defects, reproduced on
synthetic inputs and invisible on retained pages and in the tests:

1. A long ruby at a column top became a body column emitted before its owner,
   through the rule "a long narrow box at the band top is a column". Three real
   ruby boxes moved to their column top reproduced it; candidates 03 and 05 were
   right.
2. Two or more short rubies at column tops in one band all became body, because
   the lane sample admitted ruby boxes and the median spacing collapsed.
3. Bunka p1 was still worse than candidate 04: two fragments of one column in the
   wrong order (lone long boxes founding articles outside the reach filter) and the
   left-page title block emitted among right-page captions. The neighbour proxy
   cannot see either, so "0 inversions on Bunka p1" was misleading.

Partial fixes: the option-label fix covers digits only (options lettered A to D are
still taken as labels, as in every candidate); the page-number fix covers Arabic
and full-width digits only (`一八`, `p.18`, `18頁` are still continuations); a
single-column block inside another article's reach still loses its article and
ruby; a ruby just below a short column can become its continuation; the upright
rule dropped flat single-character columns; the mixed-page test left everything
after the passage unconstrained.

### Held-out run against candidate 06

Two documents from the second supplied folder, chosen by name before any content
was read and absent from the development and reserved manifests, were run in
process on CPU with the committed candidate 06 policy. (Two other candidates,
2021-12 and 2019-12, turned out to be reserved holdouts of the earlier process and
were not opened.)

| Document | Pages | Regions | Unchanged | Applied |
| --- | ---: | ---: | ---: | --- |
| N1 2018-12 | 15 | 878 | 15 | none |
| Collected past papers ("1995" file) | 640 | 43,021 | 638 | p17, p147 |

- p147 is a page of horizontal questions around a boxed vertical passage of 13
  columns with a source line. Compared with the raster by one reader: the passage
  is in order, the bracketed label precedes it, the questions above keep their
  order. Four small in-text note marks and two ruby fragments are emitted around
  the passage rather than with their columns, and the source line follows them.
- p17 is a **false positive**: a horizontal listening page with four bar charts.
  The chart axes were recognized as four tall boxes of ideographs with scores of
  0.31 to 0.49, the page was treated as vertical and 117 of its 173 regions moved.
- p139 was left unchanged by the script gate; p537 by the missing-band guard.

Both documents are development inputs now. Nine PDFs of the second folder remain
unopened.

### Changes in candidate 07

Withdrawn from candidate 06:

- "A long narrow box at the band top is a column whatever the spacing."
- The lane sample that counted narrow band-top boxes. Lane spacing is again the
  closest pair of full-width columns, with the threshold back at 0.75.

Consequence, recorded as two strict expected-failure unit cases: a narrow column
that has full-width columns only on both sides stays unassigned (Bunka p1 `#17`
again, as in candidates 03 and 05). Counting narrow boxes repaired that but turned
ruby into columns, which is the worse error because it puts ruby inside body text.

Changed:

- The upright limit is 0.4 instead of 0.75, so flat single-character columns keep
  their place while horizontal lines are still refused.
- A page is vertical only if at least two long boxes with kana or ideographs were
  recognized with a score of at least 0.6, in addition to the script majority.
  Region scores are read when present; nothing else in the policy uses them.

Kept from candidate 06: bare numbers are not passage labels; the reach filter for
single long boxes; narrow continuations except numbers and page numbers; the
furniture overlap test; the script majority.

Not attempted, by decision: lettered options as labels, non-Arabic page numbers,
single-column blocks inside another article's reach, ruby under a short column,
Bunka p1, footnotes and note marks beside a boxed passage, contents pages,
colophons, two-column headings, spaced names.

### Results and verification

Tests: the reviewer's repros for findings 1 and 2 and for the flat column are unit
cases and pass; the chart page is a unit case with scored regions; the mixed-page
test now also requires the label directly before the passage and the lines below
the passage in input order after it. All assertions of the candidate 04 and 05
test files still pass except the four-column narrow case, which is one of the two
recorded limitations.

Synthetic pages: 48 of 48 on order, ruby set and ruby owners, same CER table.
Retained real pages (414 observations): 27 changed against candidate 03, applied
65 to 70, inversions 642 to 9 overall and 76 to 9 on pages both apply,
not-consecutive neighbours 207 to 69 and 129 to 62, number labels inside article
bodies 3 to 1. Against candidate 06 only Bunka p1 changes (both providers).

Supplied documents replayed with candidate 07 over stored regions (805 pages,
52,937 regions): 802 pages unchanged, including the chart page and all 44 pages of
the Chinese case file; the three pages with a boxed vertical passage (2022-07 p6,
2022-12 p6, the collected-papers p147) are applied.

All four Nx targets pass without cache: **975 Python unit tests**, one existing
skip and two expected failures, **22 TypeScript tests**, **216 integration tests**,
Ruff on 175 files, mypy on 91 source files and TypeScript typecheck. Fresh CPU and
DML source workers pass the strict verifier on the six pages with seven injected
faults rejected; the rebuilt local package reproduces all **393** boxes over the
real HTTP path; LAW durable readback returns them unchanged. These six pages have
not changed since candidate 04 and do not exercise the rule changes. Runtime SHA256
`10e0683fdec9a6aacf38cdd6c772596c77ccade637e50ebfb8247501987c6ea4`; worker archive
SHA256 `4905869f6758d8ea08eb5065d11f9469c168da2c394a78389a6aa62e6ee9507b`. Local
candidate bytes with source version 0.4.4; nothing was published.

| Candidate 07 source or record | SHA256 |
| --- | --- |
| `ocr_reading_order.py` | `2e95c1e285d9b79ed8b25b26cace9d82931cee1db9fa664fb2f07315638b272d` |
| `reading-order-mixed-pages.json` | `760270ef5187ddd7cb5d208bde0ff459640a524b73756d3da21e23199cfaae1d` |
| `replay-candidate-07-2e95c1e285d9.json` | `f664d18b087ff9608c3f7d50859b1a7a71b7804ad650a4049906a74dc7f7d6e8` |
| `unseen-replay-candidate-07.json` | `b155fbc9c4d7050575e00edd5b5e2a500c1cda7552629fce3c464412e639fe2c` |
| `fresh-worker-dml-07/completed.json` | `10becda7c4fda0ed00be50825105513cb27d352a5159672b53103b2a2780e4d7` |
| `fresh-worker-cpu-07/completed.json` | `fc652ee186defe161ef4a4468ed536cc71553dce4a701e219f5ae0e7de00af25` |
| `fresh-worker-verification-07.json` | `dbc50b87b214ce069739614bea01f86126c4356ae651120f5c601a8dd5ab61c4` |
| `packaged-semantic-07/verification.json` | `8e88918029f3aab3df159a5e810131b5ebcd9948a4de43ed97f232a6810cc9e6` |
| `law-receipt-readback-07.json` | `83b399269ef4b107466ed9ce1351c1b33cac5fd92e174a4d11a6d0423d12bd71` |

Records and `_07` helpers are under `tmp/vertical-japanese-ocr-phase0/phase1/`;
held-out runs are in the `heldout06-*` folders.

### Assessment

Ruby, narrow columns, lone boxes, labels and page numbers overlap in size and
position, and this policy separates them with thresholds. Three review rounds each
moved errors along that boundary instead of removing them. Whole-column order on
ordinary vertical pages, facing pages and boxed passages has been stable since
candidate 04 and held on every held-out page. Further gains on the boundary cases
need evidence the policy does not have (glyph size from recognition, or a layout
model), not more thresholds.

### Open after candidate 07

- Independent review of candidate 07 and an unseen vertical page run against it.
- Cert strict semantics, warm-p95 resources, complete page gold.
- The limitations listed under "Not attempted".

## 2026-10-05 — candidate 08: fourth review and small corrections

Author: Claude Opus 5.5. The review of candidate 07 was done by a fourth read-only
agent. It has not seen candidate 08.

### Independent review of candidate 07

Verdict: the step back is mostly clean and there is no blocker. The lane logic is
candidate 05's again; over 462 retained observations candidate 07 differs from 06
only on Bunka p1 `#17` (admitted), with no page changing between applied and
unapplied; over the 805 supplied pages the only change against 06 is the chart
page. No assertion was removed or weakened, the two expected failures fail for the
stated reason, and every number and hash reproduced. The three applied supplied
pages match the description in the candidate 07 section line by line. Both ruby
defects of candidate 06 are gone (3 of 3 real ruby boxes, 0 of 2,350 grid cells).

Two defects not admitted in the candidate 07 section, both on synthetic inputs:

1. A score of exactly 0.0 counted as readable, because a missing score and a zero
   score were treated alike.
2. The upright limit of 0.4 re-admitted two-character horizontal lines (`以上`,
   `図1`, a two-character name) as body or signature. "Horizontal lines are still
   refused" held only for three or more characters.

Notes: the chart guard rests on recognizer scores in both directions (two chart
boxes scored above 0.6 would reapply the page; a vertical page with fewer than two
columns at 0.6 or above is left in input order; the retained page closest to that
has 4 readable columns of 9). The narrow-column loss against candidate 06 is 1,016
of 25,500 synthetic bands (4.0%), and it occurs whenever no two full-width columns
stand one lane apart, which is slightly wider than "full-width columns only on both
sides". Two limitations were missing from the candidate 07 list and two record
sentences overstated; both are corrected below and in the ledger and changelog.

### Held-out run against candidate 07

Three documents from the second supplied folder, chosen by name before reading and
absent from the development and reserved manifests: N1 2002 (49 pages, 1,760
regions), 2010-07 (15 pages, 850) and 2013-07 (16 pages, 844). All 80 pages are
unchanged and none contains a tall box, so they are entirely horizontal. They
confirm horizontal identity and add no vertical evidence. Six PDFs of that folder
remain unopened.

### Changes in candidate 08

- A region without a score counts as readable; a score of zero does not. The two
  refusals have separate diagnostics (`long_lines_without_kana_or_ideographs`,
  `fewer_than_two_readable_vertical_lines`).
- The upright limit is 0.6: a nearly square single-character column keeps its
  place and a two-character horizontal line is refused. A very flat single
  character such as `一` at the top of a band is left unassigned.

No retained page changes against candidate 07, and the six fresh pages are
unchanged.

### Known limitations (complete list for candidate 08)

- A narrow column is left unassigned when no two full-width columns of its band
  stand one lane apart (Bunka p1 `#17`; two strict expected-failure unit cases).
- A ruby at a column top that stands clear of the rightmost column of a band can
  be read as a column; a ruby just below a short column can be read as its
  continuation.
- A single-column block inside the reach of another article has no article of its
  own and loses its ruby.
- Options lettered A to D above a passage are read as its label; only bare numbers
  are excluded.
- Page numbers written as `一八`, `p.18`, `18頁` or in brackets under a column are
  read as continuations; only Arabic and full-width digits with dashes are excluded.
- Footnotes, note marks and ruby fragments beside or inside a boxed passage are
  emitted around the passage (2022-07 p6, collected papers p147).
- A header row holding both a corner header and a line above side questions is not
  read first; with several article domains a footer below all of them stays with
  its page.
- The vertical-page decision depends on recognizer scores: a vertical page with
  fewer than two columns scored 0.6 or more keeps its input order, and a horizontal
  page with two well-read tall boxes of ideographs side by side (vertical tabs,
  table headers, chart labels) is still reordered.
- A sideways scan of Chinese or Japanese prose is not detected.
- Contents pages, colophons, two-column headings and spaced names are ordered
  poorly; Bunka p1 is worse than in candidate 04.
- A very flat single-character column is left unassigned.

### Results and verification

Tests: three scores for the chart case including 0.0, the two-character line as
neither body nor signature, and the diagnostic of the chart refusal are unit cases.
Synthetic pages: 48 of 48, same CER table. Retained real pages: identical to
candidate 07 (inversions 642 to 9 overall and 76 to 9 on pages both apply,
not-consecutive neighbours 207 to 69 and 129 to 62). Supplied documents replayed
with candidate 08 (885 pages, 56,391 regions): 882 unchanged; the three pages with
a boxed vertical passage are applied.

All four Nx targets pass without cache: **978 Python unit tests**, one existing
skip and two expected failures, **22 TypeScript tests**, **216 integration tests**,
Ruff, mypy and TypeScript typecheck. Fresh CPU and DML source workers pass the
strict verifier on the six pages with seven injected faults rejected; the rebuilt
local package reproduces all **393** boxes over the real HTTP path; LAW durable
readback returns them unchanged. Runtime SHA256
`7d6564d8b8d22e5d22150062e4be7321d72f02b8253af675534129ae87682557`; worker archive
SHA256 `0e52ff79e60bee0fbcbb0128e6681a6867ebb647146def509846c2440825533e`. Local
candidate bytes with source version 0.4.4; nothing was published.

| Candidate 08 source or record | SHA256 |
| --- | --- |
| `ocr_reading_order.py` | `e4d48198292bbf93289fdd31424dae7a361685b702ca120e319b9a32c0078d33` |
| `replay-candidate-08-e4d48198292b.json` | `19264e028c2d8511c5be71b244a5a71ade27eddd56cab0fde4baa6315b657aec` |
| `unseen-replay-candidate-08.json` | `95777abe3da0d40ab2e39cbd56054b654480df52c1f2f9863045b4b07da0ffdd` |
| `fresh-worker-dml-08/completed.json` | `4bea49892fb25f7e9ba467851af50da3f1b3735bd84d34247eb7791a400f5327` |
| `fresh-worker-cpu-08/completed.json` | `7f35b81cfb4ba8a0c28f42350241bd509afe3b128212b7f794f2ce5cdfee3467` |
| `fresh-worker-verification-08.json` | `6cd00b1714b9b8fdafa38259efac8635b713e2ae9dd986fd3b727c0ce61ff392` |
| `packaged-semantic-08/verification.json` | `16387c124c4e949127536309cf5997db53496a2e83563f3c9601e631c22a3a08` |
| `law-receipt-readback-08.json` | `30f145f946f395a54bf2644a47d6f313cd793ffbd15ef58ee755246cf5294c33` |

### Open after candidate 08

- Independent review of candidate 08.
- An unseen vertical page: none of the 885 supplied pages run so far that was
  vertical had been unseen by the candidate it now passes on. The user has released
  the documents reserved by the earlier process for this purpose.
- Cert strict semantics, warm-p95 resources, complete page gold.

## 2026-10-05 — fixture de-identification and reserved documents

### Source text removed from the repository

The user pointed out that the source PDFs are copyrighted and must not be uploaded.
No PDF, raster or archive was ever committed, and the branch has not been pushed.
The real-page test fixtures, however, held the recognized text of whole pages (N1
papers, a MEXT bulletin, a 1951 Bunka publication). Their text is now replaced by
class-preserving placeholders: hiragana, katakana, ideographs and Latin letters each
map to one fixed character; digits, punctuation, brackets, the three characters read
by the number-label rule and the long-vowel mark are kept; geometry, scores and
expected orders are unchanged. Lengths and positions are preserved, so text spans
and alignment tokens stay consistent. The synthetic fixtures use text written for
the tests and are unchanged.

The five branch commits were rewritten so that no commit contains the source text
(`5a8fd22`, `9da237d`, `124bf56`, `33f5fc2`, `18dbb46`, formerly `3205b3e`, `6c88ce2`,
`4a516e6`, `40b2de7`, `5560c6a`). One 37-character quotation in the Phase 0 record
was removed the same way. All 978 Python unit tests, the two expected failures and
the one skip are unchanged on the de-identified fixtures. The records still contain
isolated words and phrases of two to eight characters that document transcription
corrections.

Consequences for the evidence above:

- Fixture SHA256 values quoted in earlier sections refer to the source-text bytes.
  Those bytes are kept only in the ignored folder
  `tmp/vertical-japanese-ocr-phase0/phase1/fixtures-source-text/`.
- Commit hashes in earlier sections were updated to the rewritten commits; the
  `ocr_reading_order.py` hashes are unaffected.
- The evidence verifiers under `tmp/` (`verify_fresh_workers_*.py` and the fixture
  exporters) match fresh output to fixtures by exact text. They must read the
  source-text copies, or apply `deidentify_fixtures.py` to the observation text
  first. An exporter that rewrites a fixture must be followed by
  `deidentify_fixtures.py --check`.

| De-identified fixture | SHA256 |
| --- | --- |
| `reading-order-real-pages.json` | `0145e5c6ca2c2aeb13195438b376d7fb9c5b335353a8509babd15d333f4ff5de` |
| `reading-order-mixed-pages.json` | `f8f4435bf9cfe2f82fa6739a2690e917e2ce6ae9d07513afc62dbaed2e7941f8` |
| `reading-order-real-fragments.json` | `a2148d5e983579b26d660f0d9be14ee023db18bcd7759b9eed639911cc7f62e5` |
| `reading-order-facing-pages.json` | `088a4530f8d9915ac5c97cb132b02e8dd9b86114886a0cb71da81eae7b0df394` |
| `reading-order-bunka-composite.json` | `11b31aa037a06a031c223fc988001a13e468b10b6b73bc69d6edd0dffa3b67d2` |

### Reserved documents

An error in the unseen runs of the candidate 06 section: the batch of four newer
scans (2021-07, 2022-07, 2022-12, 2023-07) was not checked against the reserved
manifest before it was run. Three of them were documents the earlier process had
reserved as holdouts (P1 2022-07 and 2022-12, P2 2021-07). They were run without
prior sight of their content and the results are reported as observed, but the two
vertical pages then informed candidate 06, so those reservations are spent.

The user released the remaining reserved documents. 2021-12, 2020-12 and 2019-12
(43 pages, 2,160 regions) were run in process on CPU against candidate 08: all 43
pages are unchanged and none contains a tall box. They are horizontal throughout
and add no vertical evidence. All six reserved documents are now exposed.

Across every supplied document run so far (928 pages), three pages hold vertical
text, all of the same kind: one boxed vertical passage among horizontal questions.
An unseen vertical page for candidate 08 therefore has to come from other material,
for instance scanned vertical publications like the Bunka and MEXT development
pages. Six PDFs of the second supplied folder are unopened and are expected to be
horizontal as well.

## 2026-10-05 — candidate 09: unseen vertical pages and band order

Author: Claude Opus 5.5. No reviewer has seen candidates 08 or 09.

### Unseen vertical pages against candidate 08

The supplied N1 papers hold almost no vertical text, so three PDFs were taken from
the official archive page that the development material came from (files
`93835301_01`, `93806101_02`, `93721601_02`; 10, 1 and 5 pages). They were chosen by
position in the index and checked against the development manifests before any
content was read, downloaded only into the ignored evidence folder, and run in
process on CPU against the committed candidate 08 policy. Two pages are horizontal
covers and stayed unchanged. The other 14 are dense facing-page scans with stacked
bands; three used the facing-page frames and three had a cross-band split.

- Columns inside bands: of 1,586 neighbouring column pairs the detector order has
  1,483 the wrong way round; candidate 08 leaves 2.
- Bands: comparing one page (`93835301_01` p7, two pages of three bands) with its
  raster showed the columns right and the **bands wrong**: on the right page the
  bottom band came before the middle one, and the top band of the left page came
  last.

A proxy for this (two articles of at least three columns that share 60% of their
x-range and whose tops are 100 px apart must be emitted upper first) gives:

| Pages | Stacked pairs | Wrong, candidate 03 | Wrong, candidate 08 | Wrong, candidate 09 |
| --- | ---: | ---: | ---: | ---: |
| 14 unseen archive pages | 88 | 4 of 67 | 7 | 3 |
| Retained development pages | 29 | 1 of 17 | 1 | 0 |
| Retained MEXT 2019-07 | 85 | 1 | 1 | 1 |
| Retained 月報 117, 文部時報 1277, 月報 001 | 182 | 0 | 0 | 0 |

The defect is as old as candidate 03. It stayed hidden because the neighbour proxy
used since candidate 04, by the author and by all four reviewers, compares columns
inside one band only. Bunka p3 had carried one such error throughout.

### Cause and change

Rows were separated with one overlap allowance for the whole set of units: a tenth
of the height of the shortest unit present. One page number beside the bands made
that allowance under two pixels, while the outlines of stacked bands overlap by 1
to 14 px on these scans. Two bands then fell into one row and were ordered by
their horizontal centres.

Candidate 09 computes the allowance per pair of units: a tenth of the shorter of
the two, at most 0.75 em when one stands above the other, and at most a quarter em
when they stand side by side. A page number beside a band no longer changes how
two bands separate, and a heading column beside two bands still joins them into
one row, so headings keep their place (月報 117 p4 is unchanged).

Not fixed: the three remaining wrong pairs on the unseen pages (p6, p9) come from
one detector box spanning two bands that the limited split did not take; its
article then covers both bands. The one on MEXT p7 is a magazine page with an
embedded horizontal figure.

### Results and verification

New tests: three stacked bands that overlap by 0, 6 and 14 px beside a page number
(two of the three fail on candidate 08), side-by-side articles with offset tops,
and the p7 page as a de-identified regression input asserting the order of its 142
body columns across pages and bands (fails on candidate 08).

Retained real pages against candidate 08: Bunka p3 changes on both providers (its
left page now reads top, middle, bottom); MEXT p15 and p16 change in the order of
small horizontal figure labels only, with article order and the reviewed body
fragments unchanged. Nothing else changes. Synthetic pages: 48 of 48, same CER
table. Neighbour proxy unchanged (642 to 9 overall, 76 to 9 on pages both apply).

All documents replayed with candidate 09 over stored regions (944 pages, 60,570
regions): 927 unchanged; applied are the three pages with a boxed vertical passage
and the 14 archive pages. On the archive pages the neighbour proxy gives 2 inverted
of 1,586.

All four Nx targets pass without cache: **983 Python unit tests**, one existing
skip and two expected failures, **22 TypeScript tests**, **216 integration tests**,
Ruff, mypy and TypeScript typecheck. Fresh CPU and DML source workers pass the
strict verifier on the six pages with seven injected faults rejected (the verifier
reads the source-text fixture copies); the rebuilt local package reproduces all
**393** boxes over the real HTTP path; LAW durable readback returns them unchanged.
None of those six pages changes. Runtime SHA256
`148fb0a1cd4027356ccd159a8be297aad7d3cbcf33fa78392316c96b93083f1b`; worker archive
SHA256 `b44fe1df3b2d28b08bf8ffd64773434bb2491faab53a9959c40e0821f9d3b2bf`. Local
candidate bytes with source version 0.4.4; nothing was published.

| Candidate 09 source or record | SHA256 |
| --- | --- |
| `ocr_reading_order.py` | `da37503e60f4bc29673d9d0513e61cf9be48a3d0a6b99df05e46a6a18144fe84` |
| `reading-order-stacked-bands.json` (de-identified) | `1f115401f30d04528f47e3b5eb8633c98d63fba59871a414fe6e649cf288144f` |
| `replay-candidate-09-da37503e60f4.json` | `16f4c963a747d157a7e0906c5d10a6f1cb980b935929bb04d58f782d7da912c9` |
| `bands-and-supplied-candidate-09-da37503e60f4.json` | `a7d289d9bb353ec58125fecc271a8e267ce9abb3aec7d2b2ffb9fde0fb572398` |
| `fresh-worker-dml-09/completed.json` | `351c38c54bacc786956f138a123f8264b6469c9a9e0468e1add6d4ab4744fb1d` |
| `fresh-worker-cpu-09/completed.json` | `b7fec2dd3c7a7dce3e62d5ca8a045776c864ce0c94e9f70c80da9280320e215c` |
| `fresh-worker-verification-09.json` | `e0cd6ae0da015cba47330ccb4f79a5ebae4153793eb1ad7bb51e53b5e75a5cdf` |
| `packaged-semantic-09/verification.json` | `2bf055276829c8c4b5bd38f83ed4053df171ddf0cb8448cbb9d436fab0512a95` |
| `law-receipt-readback-09.json` | `86803d1d26fd043b774fbd50ca2506766b80a1bfe54f1e3f60e83a9bbbf4e0db` |

### Known limitations added to the candidate 08 list

- One detector box spanning two bands that the limited split does not take merges
  those bands into one article. Every unit of that page side can then fall into
  one row and be ordered by horizontal centre alone, which scrambles it
  (archive `93835301_01` p9, right page, with two such boxes).
- The stacked-band proxy and the neighbour proxy together still cannot judge page
  order, labels, ruby or furniture; only the raster comparisons and fixtures do.

### Open after candidate 09

- Independent review of candidates 08 and 09, with the stacked-band proxy.
- An unseen vertical page against candidate 09. The 14 archive pages are
  development inputs now; the same archive index lists many more issues.
- Cert strict semantics, warm-p95 resources, complete page gold.

## 2026-10-06 — fifth review, second unseen periodical run and stopping point

No policy change in this section. Candidate 09 (`ocr_reading_order.py` SHA256
`da37503e60f4bc29673d9d0513e61cf9be48a3d0a6b99df05e46a6a18144fe84`) stays as it is.

### Independent review of candidates 08 and 09

A fifth read-only agent found no code blocker: the band fix does what it claims,
every hash and number reproduced except one count (three pages used the facing-page
frames, not four; corrected above), de-identification holds in all seven commits
with policy output identical on source-text and de-identified copies, and no test
was weakened beyond the admitted one. Asked to compare outputs with rasters rather
than rely on the proxies, it found on the 14 archive pages of the previous section:

1. **Facing pages interleaved** (`93721601_02` p5): one noise box of a single
   character inside the gutter defeats the page split, and two essays are emitted
   band by band across both pages. Without that box the page is correct.
2. **Bands split by a centre title box are read half by half** (`93806101_02` p1):
   the right halves of two bands, then the title and author, then the left halves.
3. **One page side fully scrambled** (`93835301_01` p9), now described in the
   limitation above.
4. Smaller: a left-page title and author block emitted after the first twelve
   columns of its essay; page numbers emitted before the last column of a page.

All four exist in candidate 03 as well. Regressions of candidate 09 against 08, on
horizontal text only: the two side-by-side bullet blocks of a figure on MEXT
2019-07 p15 and a colophon on archive p10 are interleaved line by line where 08
kept each block together. Neutral on MEXT p16.

Test gaps it demonstrated: restoring the old upright limit passed every test, and
most parameters of the row rule were pinned only by replays of real pages. Both
are closed below as far as a unit case can: the two-character line now has a
width that only the upright limit refuses, and a heading column beside two bands
pins the side-by-side allowance. The tenth-of-shorter bound and the exact 0.75 em
(one page distinguishes it from 0.5, by one to two pixels) remain unpinned. The
row rule is quadratic in the units of one level (0.15 s against 0.001 s on 1,000
staircase units) and its result can depend on enumeration order when two units
have exactly equal top and bottom.

### Second unseen periodical run against candidate 09

Three more files from the same official archive index (`93755401_01`,
`93807801_01`, `93894301_01`; 11 pages, 10 vertical), chosen and checked as before
and kept in the ignored folder. Proxies: 772 neighbouring column pairs, 683 the
wrong way round in detector order, 6 after ordering; 68 stacked band pairs, 1
wrong. Two pages were compared with their rasters and both are wrong in ways the
proxies see partly or not at all:

- `93807801_01` p3: two facing pages of two bands, gutter about 55 px, which is
  below the three-em page test. Emitted as right top, left top, right bottom,
  left bottom.
- `93755401_01` p2: a decorative border recognized as one box as tall as the page
  overlaps everything vertically, the two bands fall into one row, and the lower
  band is emitted before the upper one.

### Assessment and decision

Across both periodical runs, columns inside a band are ordered correctly almost
everywhere (8 of 2,358 neighbouring pairs wrong). Page structure is not: the page
split, the row split and the fallback each rest on one fixed geometric test, and a
noise box, a narrow gutter, a border, a centre title or a spanning detector box
defeats it. Each of the last rounds repaired one such case and shifted another.
Making this layer reliable needs a redesign (page and band separation from
whitespace that no column crosses, ignoring specks and thin tall boxes), not
further thresholds.

The user decided on 2026-10-06 to stop here: the result does not have to be fully
usable, the JLPT kind of page is the working scope, and periodical page structure
is recorded as a known limitation. No further policy change is planned in Phase 1.

### Known limitations, complete

From the candidate 08 list, unchanged: narrow column between the only full-width
columns; top ruby clear of the rightmost column; ruby under a short column;
single-column block inside another article's reach; lettered options read as a
passage label; non-Arabic page numbers under a column; footnotes, note marks and
ruby fragments around a boxed passage; a two-unit header row; footers on
multi-domain pages; score-dependent vertical-page decision; sideways scans of
prose; contents pages, colophons, two-column headings, spaced names; very flat
single-character columns.

Page structure of dense periodical scans:

- Facing pages are read across both pages when the gutter is narrower than three
  ems or holds any box.
- A box as tall as the page (border, rule, margin strip) joins all bands into one
  row; bands then follow their horizontal centres.
- A band interrupted by a centre title or picture is read as two half-bands.
- A detector box spanning two bands that the limited split does not take merges
  them and can scramble that page side.
- Stacked bands whose outlines overlap by more than 0.75 em, or with a loose box
  inside their x-range in the overlap, merge.
- Title and author blocks and page numbers of periodical pages are often emitted
  away from where they read.
- Horizontal text blocks side by side inside a vertical page (figure captions,
  colophons) can be interleaved line by line.

### Open

- Strict Cert semantics, warm-p95 resources, complete image gold, and the formal
  gate review of Phase 1 against the scope above.
- If periodicals become a requirement: the page-structure redesign described
  above, with raster comparison as the acceptance method. The proxies used in this
  record cannot show page order, half-bands, labels, ruby or furniture.

## 2026-10-06 — Phase 1 closing status

Implementation of Phase 1 in this repository ends with candidate 09. This section
states where each Phase 1 requirement of the spec stands. It is the author's
account, not a gate review; "passed" is not claimed for the phase.

| Requirement | Status |
| --- | --- |
| Reading order after strict normalization, one plan for text, boxes and scores | Done. Six candidates, each independently reviewed. |
| Whole-region permutation; unsplit tuples exact; public fields unchanged | Holds on every fresh, packaged and replayed page. |
| Horizontal pages unchanged | Holds on both controls and on 927 supplied horizontal pages; one chart page and one sideways page needed guards and now hold. |
| Limited cross-band split with conserved parent text, geometry and scores | Done for the studied Bunka case; three further splits occurred on unseen archive pages. Boxes the split does not take remain a limitation. |
| Required mixed layouts | Met for the JLPT kind (horizontal questions with a boxed vertical passage, A/B passages, ruby, signatures) and for the rendered set. Bunka-type periodical pages: column order yes, page structure not reliable; accepted as a limitation by the user's decision of 2026-10-06. |
| Two unseen full documents | Replaced by what was available: the six reserved N1 documents and other supplied papers (928 pages), and 27 pages of official archive periodicals. In-scope pages were correct on first sight except one label defect, fixed in candidate 06. Periodical pages exposed the page-structure limitation. No page is unseen for candidate 09 any more. |
| Fresh CPU and DML inference | Done on six pages per provider with a strict verifier. |
| Packaged validation | Done: locally built package, real HTTP journey, 393 boxes identical to the source worker. Not a published artifact. |
| LAW readback | Done: 393 boxes unchanged through LAW's SQLite, DPAPI and encrypted-blob owners. Component level, not a host journey. |
| Cert parsing and round trip | **Not met.** See below. |
| Nx lint, typecheck, unit, integration | Pass: 983 Python unit tests, two recorded expected failures, 22 TypeScript, 216 integration. |
| Independent gate review | Not held. Five bounded reviews by read-only agents exist; none is a phase gate, and the spec names a reviewer that was not available in this work. |
| Resource reference for later phases | Measured, see the [Phase 2 preparation](vertical-japanese-ocr-phase2-preparation-2026-10-06.md). |

### Cert consumer, measured on candidate 09

The actual `parse_jlpt_question_blocks` of the Cert working tree (repository head
`94b40f8` plus its uncommitted parser changes, `exam_content.py` SHA256
`d96c182c6018db816419512129ca3f8a3a67d0b4633129e3afa9cbe0af66f639`) was run on the
candidate 09 text and on the detector-order text of six in-scope pages
(`cert_probe_candidate_09.py`):

| Page | Questions on the page | Parsed, detector order | Parsed, candidate 09 |
| --- | ---: | ---: | ---: |
| 2023-12 p16 | 1 | 0 | 0 |
| 2024-07 p16 | 1 | 0 | 0 |
| 2025-07 p16 | 1 | 1 | 1 |
| 2022-07 p6 | 3 | 2 | 2 |
| 2022-12 p6 | 3 | 0 | 0 |
| collected papers p147 | 2 | 1 | 1 |

Every parsed question has its number, stem and four choices. Reading order does
not change the outcome on any page: the questions are horizontal and were already
in order. What blocks the rest is upstream of ordering and inside Cert:

- the detector often returns an option number as its own box or drops the first
  one, so a question has fewer than four numbered lines;
- Cert does not attach the vertical passage to its question (`group_prompt` is
  empty), so the improved passage order is not yet used by the consumer.

The Cert parser work listed in the spec stays open in the Cert repository. It
cannot be finished from the runtime side, and the missing markers are a detection
matter that Phase 3 evaluates.

### What closing means here

- No further change to `ocr_reading_order.py` is planned in Phase 1.
- The branch `feat/vertical-japanese-ocr-phase1` holds the work; it is not pushed
  and no version, profile or model changed.
- Opening Phase 2 implementation is the user's decision. By the spec it needs
  Phase 1 acceptance; the two unmet items are Cert semantics and the gate review.
