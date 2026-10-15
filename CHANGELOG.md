# Changelog

## Unreleased

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

## 0.6.1

A patch release. Clients still require the exact runtime version, so a 0.6.1
runtime needs 0.6.1 clients, but the contract set hash is unchanged: moving a
consumer is a version bump. The OCR profile id becomes
`capture-workbench-ocr-be5a35092b5cc3be`, since the profile carries the
release version.

### Fixes

- GPU OCR no longer fails about half the time with `ocr_worker_failed`
  (`worker_crashed`). The text detection and recognition models shared one
  ONNX Runtime profile prefix; when both loaded within the same second they
  wrote one profile file, which the DirectML execution proof then rejected as
  invalid. Each model now profiles under its own prefix.

## 0.6.0

This release is incompatible with 0.5.x: a 0.6.0 runtime needs 0.6.0 clients.
Cert Prep and LAW migrate once.

### Contract

- The contract set no longer carries the release version, so a later patch
  release keeps the same contract hash and does not force a client update.
- Capture results can carry speakers: each segment may name a speaker label,
  and the result lists the speakers with the time of a listening sample. Names
  are not part of the contract; the host stores what a person calls a speaker.
- `StartCaptureV2.identifySpeakers` asks for speaker labels. Such a capture
  reports progress but sends no partial transcript.
- Requirements may be optional (`RuntimeRequirementV2.optional`), and a result
  may suggest an optional unit that would have helped (`suggestedUnits`).

### Runtime

- New optional install unit `speaker-diarization`: who spoke when, on the CPU,
  with the Community-1 model (CC-BY-4.0) from the Capture model source.
- The second reader for vertical Japanese pages is now the optional unit
  `vertical-japanese-reader` (157 MB of models, no worker of its own). Without
  it every page is read by the regular OCR pipeline, and a page the reader
  would have taken reports the unit so the host can offer it. The OCR profile
  id does not depend on whether the unit is installed.
- A result with more than 1,000 segments is sent in several events.

### Clients and UI

- The Web Component offers optional units, shows progress while speakers are
  identified, plays each speaker's sample and emits `capture-speakers-named`.
- The Java client decodes captured text that contains line breaks.

## 0.5.1 (2026-10-07)

### Runtime

- The second reader for vertical pages is a Japanese model and now reads only
  Japanese pages: a vertical page is sent to it when its text has kana. Vertical
  Chinese pages stay with the regular pipeline, which reads them better. The OCR
  profile id changes with the routing rule.

## 0.5.0 (2026-10-06)

### Runtime

- Vertical Japanese OCR now assembles detected article columns from right to
  left and places separately detected ruby after its article, while preserving
  unchanged regions' recognized strings, polygons and scores. Horizontal-only pages
  without furigana retain their previous output.
- A second reader for vertical pages. The OCR engine now also installs the
  NDLOCR-Lite models (National Diet Library, Japan; CC BY 4.0; about 150 MiB more).
  A page that is vertical throughout is read as a whole by that reader, with its
  recognizers on the DirectML device of the regular pipeline when there is one, and
  its lines, reading order and scores are returned in the existing page and box
  fields. Other pages keep the regular pipeline. A routed page takes several
  seconds longer; the first one on a machine also prepares the recognizers once in
  the shared engine cache.
- The OCR profile declares the vertical reader, so the profile id changes
  (`capture-workbench-ocr-1c6be4a3cebc2b21`, algorithm
  `capture-workbench-ocr-profile-v3`).
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
