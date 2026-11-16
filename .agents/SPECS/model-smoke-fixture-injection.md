# Model smoke fixture injection

## Purpose

Provide a deterministic source-selection bypass for the packaged Tauri real
OCR/audio model smoke after native Windows file-picker automation proved
non-deterministic. The bypass must retain the real packaged app, runtime,
renderer capture workflow, native library validation, OCR, Whisper, Ollama,
persistence, and cleanup boundaries.

## Non-goals

- Do not expose arbitrary WebView paths or add a production import API.
- Do not treat the bypass as native-picker coverage or release evidence.
- Do not weaken the existing native picker helper or Explorer-window rules.
- Do not bundle private fixtures or model bytes.

## Interfaces

- The command is named `model_smoke_import_fixture` and is compiled and
  registered only with the `model-smoke-app-data` Cargo feature.
- Its request contains only `fixtureKey`; accepted keys are `pdf`, `image`, and
  `audio`.
- The launcher predeclares an owned fixture root and one exact path per key in
  the spawned process environment. These values never cross renderer IPC.
- The response is the existing path-free `LibraryDocumentSummary`.

## Key decisions

- Native code canonicalizes the configured root and selected fixture, requires
  the root to own the smoke TEMP/app-data layout, and requires the fixture to be
  a strict descendant.
- The selected path must be a non-symlink regular file, non-empty, within the
  library limit for its kind (2 GiB for the audio fixture, 50 MiB for the PDF),
  and use the existing source extension allowlist.
- After registry validation, the command calls the existing
  `LibraryStore::import_source`, which repeats size, signature, extension, and
  copy validation.
- After keyed fixture injection, the smoke reloads `/ocr` for documents or
  navigates to `/asr` for recordings so the application's queue stores start the
  queued item through the normal desktop capture workflow. Before starting audio,
  the smoke installs `speech-recognition` through the authenticated
  `runtime_start_installation` Tauri command; all verification and deletion
  checks read and mutate host state exclusively through Tauri commands.

## Failure modes

- Missing/unknown keys, missing configuration, paths outside the owned root,
  symlinks, directories, empty/oversized files, and unsupported extensions fail
  with bounded path-free errors.
- Production builds do not compile or register the command.
- No path, source contents, OCR text, transcript, or document name is added to
  failure diagnostics.

## Acceptance criteria

- Both feature-disabled and feature-enabled Cargo checks pass.
- Rust tests cover key allowlisting, root ownership, regular-file, extension,
  and size rejection.
- Package tests prove feature gating and opaque-key invocation.
- Model-smoke evidence explicitly says the native picker was bypassed through
  deterministic feature-gated fixture injection.
- Native UIA tests remain separately opt-in.

## Test plan

- Rust unit tests exercise fixture resolution with temporary owned roots.
- Desktop package tests inspect command registration, launcher environment, and
  model-smoke invocation/evidence labels.
- Run Cargo tests/checks, desktop package QA tests, and desktop lint only. Do
  not run the full real-media model smoke in this change.
