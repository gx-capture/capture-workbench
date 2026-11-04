# OCR readers as optional modules — design notes

2026-10-06. The user asked whether the Japanese handling could be one optional
module among several, behind an abstraction, so that LAW could use another model
for vertical Chinese. This note records what is already separable, what was
corrected at once, and what has to be measured and decided before an interface
is fixed. The decisions taken on 2026-10-07 are listed below; 0.6.0 delivered
them.
Evidence is under `tmp/vertical-japanese-ocr-phase0/direction-study/` (ignored).

## The Japanese reader only reads Japanese pages (since 0.5.1)

In 0.5.0 the routing rule looked only at layout, so a page of vertical Chinese
was sent to the NDLOCR-Lite reader, which is a Japanese model. Two synthetic pages
of vertical Traditional Chinese (text written for the probe, rendered in a system
font; `chinese_vertical_probe.py`) show why that is wrong:

| Reader | Characters wrong or missing, of 261 and 242 |
| --- | ---: |
| Regular pipeline (PP-OCR, multilingual dictionary) | 1 and 1 |
| NDLOCR-Lite reader | 31 and 30 |

The rule now also needs kana:

- A page is routed when at least 5% of the first pass's characters are kana.
- When the first pass found no kana and is sure of its text (character-weighted
  mean score at least 0.85), the page is not Japanese and stays with the regular
  pipeline; the reader is not loaded.
- When the first pass found no kana and is not sure, the reader runs, and its
  result is kept only if its own text has at least 5% kana.

The third case exists because of handwriting: on four spreads of handwritten
katakana lecture notes the first pass read no kana at all (scores 0.47 to 0.71),
while the reader read them with a third of the errors. They are still routed.
On the retained material the decision is unchanged (64 of 1,194 pages routed,
`routing_replay.py`); both synthetic Chinese pages now stay with the regular
pipeline with reason `no_kana`.

Limits: the Chinese pages are synthetic and clean, no real vertical Chinese
document was available; a poorly scanned vertical Chinese page (score under
0.85) still pays for the Japanese reader before its result is discarded; the
two thresholds were set on the pages listed here.

## What is separable today

- The adapter depends on a reader only through a small protocol: PNG bytes in,
  ordered lines (text, polygon, score) out. A reader that is not installed
  switches the whole path off.
- Routing (`ocr_vertical_routing.py`) and reading (`ocr_vertical_reader.py`) are
  separate modules, and the routing module has no heavy imports.
- The reading-order policy is mostly geometry. Its Japanese-specific parts
  (furigana on horizontal pages, ruby beside vertical columns) require kana or a
  ruby-sized box and do nothing on Chinese text. Vertical Chinese already goes
  through it: the synthetic pages were ordered correctly by the regular pipeline.

## Delivered in 0.6.0

- NDLOCR-Lite is the optional install unit `vertical-japanese-reader` (about
  157 MB of models, no worker of its own). A host chooses to install it; this
  also limits the detector licence question to hosts that do.
- A page the reader would take while the unit is missing keeps the first-pass
  result, and the result names the unit in `suggestedUnits`
  (`RuntimeRequirementV2.optional` marks such units).
- The OCR profile id does not depend on whether the unit is installed.
- There is one reader, and its interface stays inside the runtime: a page is
  chosen by its own evidence (the kana rule above), never by a language the host
  names. A vertical Chinese model may not be a whole-page reader at all, so no
  general reader interface is fixed until a second reader exists.

## Measurement of 2026-10-07: vertical Chinese on the regular pipeline

Test splits of `ZihCiLin/traditional-chinese-ocr-synthetic` (CC BY-NC 4.0, used
for local measurement only; 1,395 single-line crops, half vertical). Scripts and
results are under `tmp/zh-ocr-synthetic/` (ignored). Eight lines were composed
into a page to exercise detection and column order. Character error rate:

| Split, composed pages | Horizontal | Vertical | Vertical, NDLOCR-Lite reader |
| --- | ---: | ---: | ---: |
| Coherent text (395 lines) | 5.2% | 6.2% | 21.1% |
| Random rare characters (1,000 lines) | 48.2% | 49.0% | 81.8% |

- Direction costs about one point; column order is right.
- Two thirds of the vertical errors on single lines come from ten lines, seven
  of them faint or low-contrast lines that were not detected at all. Most of the
  rest are variant forms (爲 for 為, simplified or Japanese forms).
- The random split measures rare characters without context: 10.5% of its
  characters are not in the recognition dictionary.
- The layout-only rule of 0.5.0 would send 25 of the 26 coherent vertical pages
  to the reader; the kana rule keeps all of them with the regular pipeline.
- Limits: synthetic lines, no real page structure (rules, marginal notes,
  facing pages, seals).

## Decisions of 2026-10-07 (user)

- 0.5.1 is released with the routing correction only. The changes below are
  for a later release, after the architecture and UI discussion.
- NDLOCR-Lite becomes an optional install unit. Neither Cert Prep nor LAW
  installs it by default.
- A page that a reader would accept while that reader is not installed keeps
  the first-pass result and reports the install unit the host can offer.
- No reader for vertical Chinese is planned. Variant forms are handled in the
  host: LAW folds one-to-one variants when comparing search text and keeps the
  stored OCR text unchanged (LAW branch `feat/search-variant-folding`). The
  runtime does not normalize characters.
- The strategy is selected by page evidence, not by a language the host names,
  and its interface stays inside the runtime.

## Open

- Page structure of real vertical Chinese scans (older judgments, gazettes) is
  still unmeasured; no such document is available ([#248](https://github.com/gx-capture/capture-workbench/issues/248)).

## Not affected

Horizontal pages, furigana handling, and the reading order of pages with a boxed
vertical passage do not depend on any of this.
