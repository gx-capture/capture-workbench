# Vertical Japanese OCR

Current behaviour of the OCR runtime for Japanese pages: reading order,
furigana, and the optional whole-page vertical reader. The dated decisions are
in [the decision record](../DECISIONS/vertical-japanese-ocr.md); measurements
and limitations are in the research notes it cites.

## Ownership and contract

Capture Runtime owns rasterization, inference, normalization and ordering.
Public page/box fields do not change. One plan produces page text, boxes and
region confidences. Private source IDs preserve observation identity and the
original result/region slots.

## Reading order (`ocr_reading_order.py`)

The standard-library policy runs after strict normalization and permutes
complete, validated, non-empty regions without changing text, polygon or
score. It analyzes deskewed coordinates without rotating the raster or
modifying polygons, resolves page domains/bands before columns/articles, then
labels, short columns, signatures and ruby ownership. Each article emits
label/title, body, signature, then its own ruby run separated by blank lines.

Working scope (user decision of 2026-10-06): horizontal pages with at most a
boxed vertical passage, the JLPT kind of page. The page structure of dense
periodical scans (page, band, heading and page-number order) is a recorded
limitation.

A limited cross-band composite exception (`ocr_composite_regions.py`) splits a
source box that merges body text across separate bands only when both children
are non-blank, all non-blank CTC support lies in real crop content, and child
polygons satisfy the wire shape and raster bounds. Child spans partition the
parent string exactly once; each child inherits the parent's recognizer score.
Unsplit tuples stay exact.

## Furigana on horizontal pages

Furigana lines follow the block of lines they annotate as a ruby run separated
by blank lines, moved as whole regions. Nothing else on the page changes, and a
horizontal page without furigana keeps its output exactly.

## Whole-page vertical reader (`ocr_vertical_routing.py`)

Every page gets the regular first pass. A page goes to the NDLOCR-Lite reader
when the reading-order policy treats it as vertical, at least 80% of its
recognized characters sit in tall boxes (height at least twice the width, at
least three such boxes), and the page is Japanese: at least 5% of its
characters are kana, or, when the first pass is unsure (character-weighted
mean score under 0.85), the reader's own text has kana. Vertical Chinese has
no kana and stays with the regular pipeline.

A routed page takes the reader's lines, order and recognition scores as whole
regions; composite splitting, the reading-order policy and region lineage do
not apply to it. A page the reader cannot lay out, or reads with less than half
the first pass's characters, keeps the first pass. A reader that is installed
but altered, or that fails in inference, fails the page.

The detector always runs on the CPU provider. The recognizers run on the
DirectML device the regular pipeline selected (CPU threads when it runs on the
CPU), with no separate CPU retry. Each recognizer is optimized once per machine
into the shared engine cache and loaded from there; with the cache off or
unwritable, upstream's file is loaded, more slowly, with the same text.

## Delivery

The reader is the optional, models-only unit `vertical-japanese-reader`
(0.6.0): six upstream NDLOCR-Lite files plus their licence and notices,
pinned in the model source lock at upstream commit `636d1cfe` (CC BY 4.0). Neither Cert Prep nor LAW installs it
by default. When it is not installed and a page would have gone to it, the page
keeps its first pass and the result lists the unit in `suggestedUnits`; both
UIs offer to install it. The OCR profile (`capture-workbench-ocr-profile-v3`)
declares the reader, so result identity does not depend on what a machine has
installed. Provenance (`model`, `modelDigest`, `device`) describes the regular
pipeline; there is no per-page record of which reader read a page.

## Limitations

- Pages that mix directions (under 80% in tall boxes) stay with the regular
  pipeline, which reads their horizontal part better.
- No reader for vertical Chinese is planned; the runtime does not normalize
  characters.
- Test fixtures built from real pages hold class-preserving placeholder text
  only; source PDFs are copyrighted and are never uploaded.
