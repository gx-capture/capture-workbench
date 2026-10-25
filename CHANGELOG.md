# Changelog

## Unreleased

### Release verification

- The private speech fixture that verifies a model-enabled release is now a
  40-minute Taiwanese Mandarin interview (M4A), with its expected TEA-ASR-1.1
  output frozen from two identical CUDA runs. It replaces an MP3 whose expected
  output still came from Whisper.

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

### Speed

Measured on a Windows laptop with an RTX 4060 Laptop GPU (8 GB). Contracts,
the capture document schema and transcripts are unchanged; OCR text changes
only for images over 1024 px, which are no longer enlarged.

Speech recognition:

- A speech recognition worker keeps TEA-ASR and its aligner loaded across a
  capture's 120 s windows (0.7.1 loaded both again for each window) and, for
  five idle minutes, for the next capture (`CAPTURE_SPEECH_WORKER_IDLE_SECONDS`,
  0 to close it after each capture). It frees its GPU memory when OCR or
  speaker identification needs it.
- A TEA-ASR generation whose last 32 patterns of up to 16 tokens repeat is
  stopped, and its chunk is halved as at the length limit. On the 40-minute
  private fixture 5 of 82 chunks repeated one character 564-727 times and took
  45% of the generation time. The parsed transcript already collapsed such
  runs, so transcripts are unchanged (the fixture's normalized output hash is
  the same).
- The first capture of a worker hashes the models for the provenance digest
  beside its model load instead of after it, 5-7 s sooner.
- A 30 s clip took 21-29 s each time in 0.7.1; it now takes 24 s for the
  first capture and 6 s after. A 40-minute recording took 819 s
  through a streaming capture; it now takes 339 s.

OCR:

- An image is enlarged for OCR only when its enlarged long side stays within
  2048 px; a larger one is read as is. A 1654 x 2339 page took 23-25 s and now
  takes 8 s, with fewer errors (character error rate 0.26% -> 0.20%); dense
  11 px text in a 1080p screenshot reads as well as before. PDF pages still
  render at the full scale.
- An OCR worker keeps its DirectML sessions between captures whose pages are
  at most 2048 x 2048 px, for two idle minutes
  (`CAPTURE_OCR_WORKER_IDLE_SECONDS`, 0 to start a worker for each capture)
  and at most 20 captures. A screenshot took 7-8 s and now takes 3 s, a short
  PDF 5-6 s and now 1 s, a 5-page PDF 12 s and now 8 s; the text is the same.
  The sessions are the ones whose DirectML execution the first capture
  evidenced; the selected GPU adapter is checked again before each capture,
  and acceptance runs with an execution proof always start a new worker.
- A larger image runs on fresh sessions: DirectML keeps the GPU buffers of
  every capture, and after a 12 MP photo a warm worker held 7.8 GB of the 8 GB
  and read its next page as empty.

### Downloads and progress

- Installing an engine hard-links its files from the download cache instead
  of copying them, saving about 10.5 GB for speech recognition, and the cache
  drops entries no install uses after seven idle days.
- A streaming capture reports `loading-model` while the speech model loads and
  its progress from the recording's covered time, instead of staying at its
  start until the end.
- A download that failed while its partial files were being removed reported
  the cleanup error instead of the download's; a rebuild of a worker that
  ships in parts left an earlier build's parts behind.

### Capture lifecycle

- A streaming capture published the speech session's `completed` while the
  capture was still extracting, so a host that stopped at `completed` read a
  snapshot without the result. Only the capture's own end is published now.

### Desktop

- The desktop app offers "Use the GPU for speech recognition" when an NVIDIA
  CUDA driver is present; turning it off restarts the runtime with speech on
  the CPU (TEA-ASR mini). It cannot change while a capture or installation
  runs.
- A component installation shows a rounded percentage and a progress bar; it
  showed the raw fraction times 100 (for example 33.33333333333333%).

## 0.7.1

A patch release that makes 0.7.0's speech recognition usable from a host.
Clients still require the exact runtime version, so a 0.7.1 runtime needs 0.7.1
clients; the contract set hash (`60c62267…`) and the capture document schema
are unchanged, so moving a consumer from 0.7.0 is a version bump. The OCR
profile id becomes `capture-workbench-ocr-e012547f1f9da4da`, since the profile
carries the release version.

### Speech recognition

Found by driving the published 0.7.0 runtime the way LAW's AI service does:
list the requirements, install speech recognition and speaker identification
through the API, then transcribe.

- `GET /v2/runtime/requirements` answered 500 for every host, so nothing could
  be installed. The speech recognition worker ships as two parts of 2.95 GB,
  which the public artifact descriptor (one URL, at most 512 MiB) cannot
  describe. Such a requirement now carries no `artifact`, like a models-only
  unit, and installs from the runtime's catalog as before.
- Every capture failed while loading the speech model ("session failed at
  OSError"). Engine workers did not receive `USERNAME`, and PyTorch names its
  compile cache after it when Transformers loads a model.
- A capture with speakers timed out after 15 minutes while loading the speech
  model. The worker's cancellation listener held a blocked read of stdin, which
  on Windows holds a lock that the model load waited on. The listener now waits
  without a pending read; cancelling still stops a worker cooperatively.
- An install whose worker files would land beyond Windows MAX_PATH (a long
  `CAPTURE_APP_DATA_DIR`) failed only after about 10 GB had downloaded, as a
  bare "installation failed". It now stops before the model download and names
  the path length; a failed post-install probe keeps the worker's reason.
- Progressive transcriptions report `elapsedMs` and `stageMs` for the whole
  recording; they reported none.

The fixes are in the runtime and in rebuilt speech recognition and speaker
diarization workers. The release consumer smoke now reads the packaged
runtime's requirements, which would have caught the first defect.

## 0.7.0

A minor release with breaking changes, which the 0.x policy allows. Clients
require the same runtime minor, so a 0.7.0 runtime needs 0.7.0 clients, and
consumers move together. The contract set changes (SHA-256
`60c622670b00e144b174c210e96773e07e7d94ec7c721b33ac65ff6c722c1d93`): the speech
requirement is renamed, engine provenance gains timing, and the schemas describe
PDF page selection. The OCR profile id becomes
`capture-workbench-ocr-7680a930bb89b381`, since the profile carries the release
version.

### Breaking changes

- Rename the public runtime requirement from `whisper-primary` to `speech-recognition`; replace Whisper with TEA-ASR-1.1 (CUDA), TEA-ASR-1.1-mini (CPU) and Qwen3 forced alignment. Clients and installed engine catalogs must migrate together.
- Speech is always transcribed as Chinese (Traditional, Taiwan vocabulary), as the model card
  recommends; recordings in other languages need another model.

### Speaker diarization

- Replace the optional speaker model with NVIDIA Nemotron-3-Diarization under
  OpenMDW-1.1, using native Transformers offline inference. Preserve GPU preference,
  bounded CPU fallback, overlapping/exclusive speaker turns and worker isolation.
  Remove the internal speaker-count option.

### Engine packaging

- Publish a worker archive above 1.9 GB as ordered parts (`<archive>.001`, `.002`, ...) so every
  release asset stays under GitHub's 2 GB limit; the catalog lists each part with its digest, and
  the installer joins and verifies them. The CUDA speech-recognition worker ships this way, and
  worker extraction is bounded at 8 GiB.
- Speaker diarization runs CPU PyTorch again, which keeps its worker small; only speech
  recognition uses CUDA PyTorch.

### Engine provenance

- Add optional `elapsedMs` and `stageMs` engine provenance fields for speech recognition and speaker diarization, alongside the device that produced the result; total time includes failed CUDA attempts and CPU fallback.

### PDF page selection

- A capture's `pdfPageNumbers` may name any pages of a PDF, such as
  `[3, 7, 8, 20]`, not only a prefix from page 1. The pages are one-based
  source page numbers in ascending order without duplicates, at most 500. A
  prefix such as `[1]`, and leaving the field out to read every page, work as
  before.
- Results keep the source page numbers: the OCR projection's pages, the raw
  segments' page locators and `ocrPageScope` say 3, 7, 8 and 20, so a host maps
  them back without bookkeeping.
- The page limit (`CAPTURE_MAX_PDF_PAGES`, 200 by default) counts the pages
  that are read. Without a selection that is every page of the PDF, as before;
  with one, the PDF may be longer than the limit, and
  `ocrPageScope.sourcePageCount` is no longer capped at 500.
- A selection that names a page past the end of the PDF, or more pages than
  the limit, fails the capture with `invalid_pdf_page_selection` (not
  retryable) before any page is read; it used to fail as
  `ocr_source_preflight_failed`. `POST /v2/captures` still rejects an unsorted,
  repeated, zero or over-long selection with `validation_error`.
- The Python, Java and TypeScript clients check a selection the same way before
  uploading, and the TypeScript `CaptureUpload` gains `pdfPageNumbers`.

The OCR engine renders the selected pages, so the change reaches users with a
rebuilt `capture-engine-ocr` artifact. The contract schemas describe the
selection and require positive page numbers.

## 0.6.3

A patch release for recording transcription. Clients still require the exact
runtime version, so a 0.6.3 runtime needs 0.6.3 clients; the contract set hash
is unchanged, so moving a consumer is a version bump. The OCR profile id
becomes `capture-workbench-ocr-1f5dcb0f58337c71`, since the profile carries
the release version.

### Recording transcription

- Whisper's voice activity filter now ignores sounds shorter than 250 ms,
  Silero's own default; faster-whisper kept every sound it heard. A click at
  the start of a phone recording had become a speech chunk:
  - Whisper heard "You" in an otherwise silent window.
  - With speakers, a word spoken at 4:43, whose aligned span reached back into
    the click, was timed at 0:00 without a speaker.

  On the 40-minute interview from 0.6.2, both are gone.

The filter runs in the Whisper engine, so the fix reaches users with a rebuilt
`capture-engine-whisper` artifact.

## 0.6.2

A patch release for recording transcription. Clients still require the exact
runtime version, so a 0.6.2 runtime needs 0.6.2 clients; the contract set hash
is unchanged, so moving a consumer is a version bump. The OCR profile id
becomes `capture-workbench-ocr-5b63d123f524e4b1`, since the profile carries
the release version.

### Recording transcription

Found by transcribing a 40-minute phone interview (M4A, AAC) through LAW and
directly through the runtime:

- The progressive audio decoder kept the alignment padding of every resampled
  frame, so for Opus, MP3 and AAC sources about a fifth of the PCM sent to
  Whisper was junk and segment times drifted. It now keeps the samples only:
  a four-minute stretch sent as Opus went from one segment to 93.
- A capture no longer fails when its first five minutes produce no text.
  Recordings often open with minutes of waiting; the speech after is now
  heard. `progressive_no_text_at_sample` means the whole recording had no
  text and, as the contract already declared, is not retryable.
- Consecutive progressive windows both transcribe their 30-second overlap,
  often in different words or scripts. Each moment is now kept from one
  window, which removed the doubled sentences (877 segments became 683 on
  the interview).
- A Whisper or speaker-diarization run may take 15 minutes plus the
  recording's length; with the fixed 15 minutes, a 40-minute interview with
  speakers failed.
- The runtime, the Web Component and Capture Workbench accept any audio or
  video recording FFmpeg decodes (AAC, AMR, WMA, AIFF, CAF, MOV, MKV, WebM,
  AVI, FLV, MPEG-PS and MPEG-TS besides WAV, MP3, FLAC, Ogg and MP4); the
  audio track of a video is transcribed.
- Capture Workbench shows a recording's transcript as timed lines with the
  speakers' names beside a player, and plays the recording from a line.

The window merging and the checkpoint rule run in the Whisper engine, so
they reach users with a rebuilt `capture-engine-whisper` artifact.

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
