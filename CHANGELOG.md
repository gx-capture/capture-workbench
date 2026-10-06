# Changelog

## Unreleased

### Runtime

- Vertical Japanese OCR now assembles detected article columns from right to
  left and places separately detected ruby after its article, while preserving
  unchanged regions' recognized strings, polygons and scores. Horizontal-only pages
  without furigana retain their previous output. The OCR model and profile are unchanged.
- Groundwork for a second reader of vertical pages: when the OCR engine carries the
  NDLOCR-Lite models (National Diet Library, Japan; CC BY 4.0), a page that is
  vertical throughout is read as a whole by that reader (its recognizers on the
  DirectML device of the regular pipeline when there is one), and its lines,
  reading order and scores are returned in the existing page and box fields. The
  released engine does not carry these models yet, so its output is unchanged.
- On horizontal Japanese pages, furigana lines are no longer interleaved with the
  text they annotate: the readings of each block of lines follow that block,
  separated by blank lines. Regions, polygons and scores are unchanged; only
  their order and the page text change, and only on pages with furigana.
- A detector box spanning two body bands can be split when neighboring columns,
  raster whitespace and the same recognition pass agree on the text boundary.
  Child regions retain exact source substrings and inherited scores, with checked
  polygon partitions and private parent/span lineage.
- Vertical reading order also covers scans of two facing pages that lean
  differently (each page is read in its own frame instead of keeping detector
  order), narrow columns of small type beside regular ones, long source lines aligned to the bottom
  of an article, ruby boxes padded into their owner column, and a corner page
  header or page number beside a single article.
- A page whose tall boxes mostly hold digits or Latin text (a sideways scan of a
  horizontal page), or only low-score marks such as chart axes, is no longer
  treated as vertical and keeps its previous output.
- On a page of horizontal questions around a boxed vertical passage, the option
  numbers above the passage stay with their question instead of being read as the
  passage label, and a page number in digits under a column is no longer read as
  body text.
- Stacked bands of a page are read top to bottom even when their outlines overlap
  by a few pixels and a page number stands beside them.
- Known limitation: on dense periodical scans the columns inside a band are ordered,
  but the order of pages, bands, headings and page numbers is not reliable (narrow
  gutters, borders, centre titles and detector boxes spanning two bands).
- This work is unreleased and unversioned: the OCR model, profile and public
  page/box fields are unchanged.

### Compatibility policy

Capture Workbench follows an explicit 0.x compatibility policy:

- While the runtime is `0.x`, a minor-version change may be breaking.
- Capture Workbench clients therefore require the same runtime major and minor
  version during the readiness handshake; patch updates remain compatible.
- The in-scope consumers for the current `0.4.x` line are the published
  Web Component package, Cert Prep's Angular, Python, and desktop hosts, and
  LAW's Java engine and Python AI service. They must be deployed on the same
  minor before a runtime release is enabled.
- `compatibleRuntimeMinor` is a temporary, explicit break-glass setting for a
  coordinated rollback or split-minor migration. Remove the override after the
  consumer and runtime are aligned; reverting the consumer package is the
  rollback path if an undiscovered incompatibility is found.

The consumer consistency check is a permanent CI gate for the declared
runtime, package lock, Python host, desktop host, and browser host versions.

## 0.4.4 (2026-09-30)

- Published to npm, Maven, PyPI, and crates.io, with the runtime, engine zips,
  and desktop installer on the GitHub release; the stable pointer moved to
  `v0.4.4`. Cert Prep and LAW consume it. The official online-package PDF OCR
  E2E passes on the 44-page 2024-07 N1 PDF.

### Runtime

- A PDF page where PaddleOCR returns a region with empty text (score zero) no
  longer fails the whole capture; the blank region is skipped after its
  polygon and score are validated. The 44-page 2024-07 N1 PDF, which failed on
  its vertical-text page 16 with 0.4.2 and 0.4.3, now completes.
- PDF captures report page progress while extracting (up to 90%, one checkpoint
  per validated page, no OCR text); a failed checkpoint write skips that update.
- OCR worker failure evidence names a rejected normalization step
  (`ocr-normalize-failed-*`).
- Known limitation: vertical Japanese text is recognized but returned in the
  wrong column order, with more recognition errors than horizontal text.

### Release tooling

- The post-publish PyPI readback waits up to about five minutes for PyPI's
  metadata instead of failing on the first 404.

## 0.4.3 (2026-09-29)

- Published to npm, Maven, PyPI, and crates.io, with the runtime, engine zips,
  and desktop installer on the GitHub release; the stable pointer moved to
  `v0.4.3`. Cert Prep and LAW consume it.
- A first OCR install on fresh app data takes about 40 s (was 9–17 minutes
  with 0.4.2), and about 8 s once any Capture host on the machine has
  downloaded the engine.

### Runtime

- Engine artifacts of 16 MiB or more download as four concurrent byte ranges
  when the host supports them, falling back to one stream otherwise; size and
  SHA-256 are still verified. The 152 MB OCR engine took 4.7 minutes instead of
  roughly 15 when GitHub Releases served ~170 KB/s per connection.
- Engine workers and model files are kept in a machine-wide cache
  (`%LOCALAPPDATA%\gx-capture\engine-cache`), keyed by SHA-256 and re-verified
  on every read. A second host, a fresh app-data directory, or a reinstall
  copies the verified bytes instead of downloading them again; entries unused
  for 60 days are evicted. Set `CAPTURE_ENGINE_CACHE_DIR` to move the cache or
  to `off` to disable it.

### CI and release tooling

- Release candidates read size budgets from the tooling ref.
- `sync-versions` also updates workspace crates in `Cargo.lock`.
- The launcher's activation probe fixture keeps serving after a test client
  drops a connection, which removes the intermittent launcher test failure.

## 0.4.2 (2026-09-27)

- Runtime OCR is delivered as an installable `windowsml-ocr` engine from the
  release catalog and gated by an OCR compute preflight; PDFs are OCR-only.
- The public launcher lifecycle (prepare, activation, Running, Closing,
  Terminal) persists durable ownership and releases verified staging.
- Published to npm, Maven, PyPI (`capture-runtime-client`, first PyPI
  release), and crates.io, with the runtime, engine zips, and desktop
  installer on the GitHub release; the stable pointer moved to `v0.4.2`.
- Known limitations: handwritten text is recognised poorly (printed text is
  the supported floor); the first engine download from GitHub releases can take
  over ten minutes.

## 0.4.1

- Canonical v2 contract set shared by the runtime and its TypeScript, Python,
  and Java clients; releases require matching contract-set digests.

## 0.3.9

- Published the shared contracts, structuring SDK, and sidecar launcher
  artifacts used by the desktop and host integrations.
