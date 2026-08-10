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
- The selected path must be a non-symlink regular file, non-empty, at most
  50 MiB, and use the existing source extension allowlist.
- After registry validation, the command calls the existing
  `LibraryStore::import_source`, which repeats size, signature, extension, and
  copy validation.
- The smoke reloads the WebView, selects the queued document, and clicks the
  existing retry action to run the normal renderer capture workflow. Audio is
  retried only after Whisper consent completes. Because keyed injection does
  not execute the renderer's picker callback that reveals optional Whisper,
  the smoke records consent through the existing authenticated Tauri/runtime
  installation command before using the same UI retry path.

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
