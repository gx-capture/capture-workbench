# OCR readers as optional modules — design notes

2026-10-06. The user asked whether the Japanese handling could be one optional
module among several, behind an abstraction, so that LAW could use another model
for vertical Chinese. This note records what is already separable, what was
corrected at once, and what has to be measured and decided before an interface
is fixed. Nothing here is implemented except the correction in the next section.
Evidence is under `tmp/vertical-japanese-ocr-phase0/direction-study/` (ignored).

## Corrected now: the Japanese reader only reads Japanese pages (0.5.1)

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

## What is fixed in place

- The OCR profile declares exactly one reader and must equal constants in code.
- The model source lock and engine catalog deliver that reader inside the OCR
  engine: every install downloads about 157 MB, whatever the host reads.
- One routing rule with one destination.

## Proposed shape, not yet decided

1. **The module boundary is the install unit the system already has.** The engine
   catalog installs requirements separately (OCR, Whisper). A reader becomes its
   own requirement that a host chooses to install. This also contains the
   detector licence question to hosts that install the Japanese reader.
2. **Pages choose the reader, hosts choose what is installed.** The profile
   module states that hosts do not choose an OCR language. Keep that: each reader
   declares which pages it accepts (direction, script, confidence of the first
   pass), and the runtime routes a page to the first installed reader that accepts
   it. A document with pages in several languages then needs no host parameter.
3. **Abstract the reader only**: `accepts(first pass) -> reason or None` and
   `read(png) -> lines`, with the profile holding a list of reader declarations.
   The reading-order policy is not abstracted until a second language needs
   different ordering.

## Why not fix the interface now

- There is one implementation. A Chinese vertical model may not be a whole-page
  reader at all: the regular pipeline already reads clean vertical Chinese well,
  so the useful module could be a recognizer swap, a detector, or nothing.
- The cost of a wrong interface is another incompatible release: profile format,
  catalog and install API change, and both consumers migrate again.

## Open questions, in order

1. **Is there a problem to solve for vertical Chinese?** Needs real documents:
   scanned vertical Traditional Chinese of the kind LAW meets (older judgments,
   gazettes), measured end to end with the regular pipeline, as the direction
   study did for Japanese. None is available now. Public-domain scans are a
   possible source and would need gold or a blind second reader.
2. **If there is, what kind of model fixes it** (whole-page reader, recognizer,
   detector), with clear licence lineage.
3. **Then** the install unit and the reader interface above, in one release with
   the consumer migrations.

## Not affected

Horizontal pages, furigana handling, and the reading order of pages with a boxed
vertical passage do not depend on any of this.
