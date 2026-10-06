# Direction study — where the loss is and which route can reach the goal

2026-10-06, requested by the user after Phase 1 closed. The study itself changed no
product code; the two follow-ups the user then asked for are at the end.
Scripts, outputs and third-party code are under
`tmp/vertical-japanese-ocr-phase0/direction-study/` (ignored); no recognized or
transcribed page text is stored in this note.

## Question

The user's goal is that any vertical Japanese document reads as fluent text, with
JLPT exam documents first. The phased plan (reading order, deskew, second
recognizer) was fixed as a sequence of remedies before the loss had been measured
end to end. This study measures it and compares routes on the same pages.

## Measure

Whole-page text as the runtime returns it (candidate 09 order over the retained
DML observations) against the adjudicated double-read transcriptions in their
reading order, NFKC with whitespace removed. Three complete N1 papers have such
gold: 2024-12 (27 pages), 2023-12 (50), 2025-07 (46); 123 pages, 56,179 reference
characters (`e2e_current.py`, `e2e_split.py`, `e2e_ruby.py`).

## Finding 1: on JLPT papers the loss is furigana on horizontal pages

| Page kind | Pages | Reference characters | Edits | CER |
| --- | ---: | ---: | ---: | ---: |
| Horizontal, no furigana | 62 | 30,236 | 586 | 1.94% |
| Horizontal with furigana | 59 | 25,200 | 3,541 | 14.05% |
| Vertical or mixed | 2 | 743 | 30 | 4.04% |

- Vertical text is 2 of 123 pages. Phase 1 took those two from the detector order
  to 4%; over the whole set it moves the total by under one point.
- Pages with furigana are 48% of the set. Their base text is read as well as on
  other pages: against a reference without the furigana, 1.6% (2023-12) and 2.1%
  (2025-07) of the characters are missed or wrong. The 14% is the furigana: each
  reading is returned as its own line above the line it belongs to, so the output
  alternates readings and text. The furigana are 1,808 characters; misplaced once
  they cost about twice that in edits, which is nearly all of the 3,541.
- Whole papers: 1.06% (2024-12, no furigana), 10.04% and 10.22% (the two with
  furigana in the listening section).

So for the user's primary material, fluent output is blocked by a case the plan
never named: ruby in horizontal text. The runtime already separates ruby from body
on vertical pages; on horizontal pages it does nothing.

## Finding 2: four readers on nine pages

Nine gold pages; reference is body text without furigana in reading order;
"missed" counts deletions and substitutions, "extra" counts insertions
(`compare_all.py`, `compare-all.json`). For the periodical spread the reference is
its 108 body columns only, so titles and page numbers a reader also returns count
as extra.

| Page | Characters | Current | NDLOCR-Lite | PaddleOCR-VL | Cloud vision-language model |
| --- | ---: | ---: | ---: | ---: | ---: |
| JLPT boxed vertical passage, 2023-12 p16 | 372 | 21 / 3 | 22 / 2 | 23 / 0 | 4 / 2 |
| JLPT boxed vertical passage, 2025-07 p16 | 368 | 9 / 0 | 20 / 3 | 20 / 0 | 2 / 0 |
| JLPT horizontal with furigana, 2023-12 p40 | 117 | 2 / 100 | 13 / 12 | 14 / 40 | 2 / 0 |
| JLPT horizontal with furigana, 2025-07 p37 | 112 | 0 / 84 | 13 / 9 | 15 / 2 | 2 / 0 |
| JLPT horizontal, 2024-12 p6 | 559 | 12 / 2 | 12 / 2 | 10 / 39 | 2 / 11 |
| JLPT horizontal with tables, 2023-12 p32 | 687 | 30 / 22 | 137 / 116 | 35 / 14 | 4 / 2 |
| JLPT two vertical passages, official p14 | 793 | 91 / 6 | 24 / 2 | 33 / 2 | 2 / 0 |
| Dense periodical spread, Bunka p2 | 1,970 | 119 / 53 | 17 / 30 | 301 / 261 | 6 / 46 |
| Rendered vertical page tilted 1.5° | 394 | 294 / 10 | 12 / 0 | 7 / 0 | 0 / 0 |

Missed characters as a share of the reference:

| Pages | Current | NDLOCR-Lite | PaddleOCR-VL | Cloud model |
| --- | ---: | ---: | ---: | ---: |
| Seven JLPT pages (3,008 characters) | 5.49% | 8.01% | 4.99% | 0.60% |
| Periodical spread and tilted page (2,364) | 17.47% | 1.23% | 13.03% | 0.25% |
| All nine (5,372) | 10.76% | 5.03% | 8.53% | 0.45% |

**Current pipeline.** Good on horizontal JLPT text; the extras on furigana pages
are the readings returned as separate lines. On pages that are vertical throughout
it loses punctuation and small kana (official p14: 91 of 793), and it collapses
when the page tilts.

**NDLOCR-Lite** (National Diet Library, commit `636d1cfe`, v1.2, CC BY 4.0; one
layout model and three recognizers in ONNX, 157 MB together; CPU only, 0.7 to 1.6 s
per page for detection and recognition; run whole-page with defaults in an
isolated environment). It is the opposite profile: about 1% missed on the dense
periodical spread and 3% on the tilted page and on the two-passage exam page,
against 6%, 75% and 11% for the current pipeline, and worse than the current
pipeline on horizontal exam pages, furigana pages and tables. It also returns its
own reading order. On five unseen periodical pages where the Phase 1 policy got
page structure wrong (narrow gutter, page-height border, three stacked bands, a
noise box in the gutter, detector boxes spanning two bands), its order of pages
and bands is right on four and partly mixed on the fifth, judged from the page
and band of each long column in its output (no gold). These periodicals are the
kind of material it was built for; exam pages are not.

**PaddleOCR-VL** (the local vision-language pipeline shipped in the installed
PaddleOCR package; needed a separate environment with the Paddle framework, 2.4 GB
installed plus model downloads; 6.1 GB peak GPU memory on an 8 GB RTX 4060; 18 to
80 s per page). About level with the current pipeline on JLPT pages and poor on the
dense spread. Not a candidate: heavy, slow, outside the Windows ML path, and no
quality gain.

**Cloud vision-language model** (Claude reading the images blind in separate
sessions without access to gold or OCR output; about 12 s per exam page and three
minutes for the three harder pages together). 24 characters missed in 5,372. It
separates furigana, reads vertical passages and the periodical spread in order,
and reads the tilted page without error. It marked three characters of the old
periodical as illegible instead of guessing. It is a ceiling reference: as run it
is a cloud service, with per-page cost and latency, and private documents could
not be sent to it.

Nine pages is a small sample and all are development pages. The ranking by page
kind is clear; the percentages are not precise.

## What this says about the plan

- The three phases target vertical text. On JLPT papers vertical text is under 2%
  of pages; the larger loss there is furigana on horizontal pages (finding 1).
- The plan used NDLOCR-Lite only to re-recognize single boxes found by the current
  detector (Phase 3), after two phases of ordering and deskew work on the current
  pipeline. Finding 2 says the useful unit is the whole page: on vertical pages
  NDLOCR-Lite already does detection, recognition, tilt tolerance and page
  structure better than everything Phases 1 to 3 were meant to add, and Phase 2
  (deskew) loses its one motivating page.
- No single local reader is best on both kinds of page. The current pipeline wins
  on horizontal exam pages, NDLOCR-Lite on vertical-dominant pages.
- "Any vertical document reads fluently" at the level of the cloud reference is
  not reached by either local reader on this sample; NDLOCR-Lite comes close on
  the pages it was built for.

## Options

1. **Furigana on horizontal pages** in the existing pipeline. Bounded, local, no
   new model; 48% of JLPT pages.
2. **Route by page kind**: keep the current pipeline for horizontal and mixed
   pages, and use NDLOCR-Lite whole-page for vertical-dominant pages, taking its
   text, boxes and order. Local, CPU, about 150 MiB of models (at the edge of the
   approved budget), CC BY 4.0. Replaces Phases 2 and 3 as specified and makes the
   periodical page-structure limitation a matter of that engine. Open: the routing
   rule, mapping its lines to the public box contract and scores, pages that mix
   both directions, Windows ML or DirectML execution versus plain CPU ONNX, and
   acceptance on unseen vertical documents of several kinds.
3. **A cloud vision-language engine as an opt-in** for non-private documents.
   Highest quality; a product decision about consent, cost, offline use and the
   engine contract. Not usable for LAW material.
4. **Local vision-language model.** Not viable on this evidence.
5. **Continue Phases 2 and 3 as specified.** Not recommended.

Recommended: 1 for the primary material, then a short feasibility spike for 2
before any commitment; 3 only if the user wants the ceiling for selected documents.

## Limits

- Gold exists only for three N1 papers and a few single pages; all pages used here
  are development material, and the current pipeline's order was tuned on some.
- NDLOCR-Lite and PaddleOCR-VL were run with defaults on PNG rasters at the
  runtime's scale; no tuning was tried. NDLOCR-Lite's training data may include
  periodicals like the Bunka pages.
- The page-structure check of NDLOCR-Lite on five pages has no gold.
- The cloud reference is one model, one run per page, in sessions told not to
  read anything but the images.
- Timings are from this machine and are not comparable across readers beyond
  order of magnitude.

## Follow-up 1: furigana on horizontal pages (implemented)

The user chose options 1 and 2. Option 1 is candidate 10 of the reading-order
policy; rule, verification and limits are in the
[Phase 1 record](vertical-japanese-ocr-phase1-implementation-2026-10-02.md#2026-10-06--candidate-10-furigana-on-horizontal-pages).
On the 59 gold pages with furigana, characters in the body that do not belong
there fall from 8.10% to 0.78% with missed characters unchanged at 1.8%; the 62
pages without furigana are byte-identical. The whole-page figure of finding 1 was
not recomputed: its reference places each reading by its own convention, so it
does not measure a run of readings placed after the block.

## Follow-up 2: routing spike (measured, not implemented)

Question: can NDLOCR-Lite read vertical-dominant pages as a whole inside the
runtime, and can pages be told apart cheaply.

**Execution.** NDLOCR-Lite's own code runs unchanged in the runtime's Python
environment on the installed ONNX Runtime with the CPU provider, with the same
text as in its isolated environment; the only missing dependency is `networkx`.
0.7 to 1.6 s per page. The four model files are 149.8 MiB. With the DirectML
provider the sessions load but detection returns no lines, so as it stands it is
CPU only.

**Order on vertical pages**, 80 periodical pages (development and public archive
pages), two proxies without gold (`order_proxies.py`): a column must come after
its right-hand neighbour in the same band, and a column must come after the one
directly above it.

| Reader | Neighbour pairs wrong | Above/below pairs wrong |
| --- | ---: | ---: |
| Current pipeline, candidate 09 | 15 / 6,608 (0.23%) | 75 / 3,433 (2.18%) |
| NDLOCR-Lite | 2 / 6,502 (0.03%) | 11 / 3,229 (0.34%) |

The current pipeline's above/below errors are concentrated on four unseen
periodical pages (16 to 29 each), where NDLOCR-Lite has none; NDLOCR-Lite has 3 or
4 on three pages where the current pipeline has none.

**Routing signal.** Share of recognized characters that lie in tall boxes, from
the current pipeline's own first pass (`routing_stats.py`):

| Material | Pages | below 0.02 | 0.02 to 0.5 | 0.5 to 0.8 | 0.8 and above |
| --- | ---: | ---: | ---: | ---: | ---: |
| N1 papers, development | 167 | 163 | 1 | 3 | 0 |
| N1 papers, supplied | 884 | 873 | 11 | 0 | 0 |
| Official N1 sample | 3 | 2 | 0 | 0 | 1 |
| Periodicals (Bunka, 117, 1277, 001, public archive) | 60 | 7 | 1 | 3 | 49 |
| MEXT bulletin | 35 | 7 | 8 | 6 | 14 |
| Private Chinese case file | 44 | 43 | 0 | 1 | 0 |

A threshold of 0.8 sends no exam page with a boxed passage (0.54 to 0.59) and not
the sideways Chinese page (0.69) to the second reader, and sends the official
two-passage page and most periodical pages. The bulletin is the unclear case:
its pages mix horizontal tables with vertical text across the whole range.

**What it does not show.** No gold-based accuracy beyond the nine pages of
finding 2. The routed path was not built: the signal costs a full first pass of
the current pipeline, so a routed page pays for both readers. NDLOCR-Lite's lines
and scores were not mapped to the public box contract. Pages between 0.2 and 0.8
have no good reader. Attribution for CC BY 4.0 and the place of a second engine
in the engine catalog and profile are undecided. All pages here are development
or already exposed pages.

**Assessment.** Feasible on CPU at about 150 MiB, with a clear gain on
vertical-dominant pages in recognition (finding 2) and in page structure (this
section), and a workable first routing rule. It replaces Phases 2 and 3 as
specified and adds an engine, which is the user's decision.
