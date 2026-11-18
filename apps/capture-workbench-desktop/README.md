# Capture Workbench Desktop

This Tauri 2 app is the Windows 11 x64, local-first Capture Workbench product.
It owns the user's private source/result library and starts one verified
Capture Runtime sidecar with a memory-only bearer token.

The Windows product runs as a single instance. Starting it again restores a
minimized main window, shows and focuses it, and exits the second process.
Second-launch arguments and working directory are ignored. Builds with
`acceptance-harness` (including deterministic QA) skip the single-instance
lock so isolated test runs and the product can coexist.

The desktop host starts one verified `capture-runtime` sidecar on a random loopback port with a memory-only 256-bit bearer token. Its product provider is an isolated Ollama lane with dedicated app data, model storage, port, profile, and PID file.

## Acceptance targets

- `capture-workbench-desktop:diagnostic-desktop-ocr` runs real OCR against the
  non-installed `build-acceptance` binary; it is a diagnostic, not release evidence.
- `capture-workbench-desktop:build-practical-installer` and
  `acceptance-practical-installed` build a side-by-side production installer
  (only the identifier, product name, and binary name differ) and run the
  canonical OCR journey against published or candidate bytes, then remove
  only run-owned state.
- `capture-workbench-desktop:acceptance-three-projects` runs Capture
  Workbench, Cert Prep, and LAW in order with cleanup proven between them.

Each consumer runs its own acceptance gate and writes its own manifest.
Cert Prep's gate is `acceptance-real` and LAW's gate is
`law-prep-web-e2e:acceptance-real`; a release is gated by those gates.
The release procedure is in `.agents/GUIDES/release-runbook.md`.

Run `corepack pnpm dev` for the product lane. It generates and stages release
runtime assets before Tauri starts. `corepack pnpm dev:deterministic` remains a
diagnostic-only test lane and never proves real engines or Ollama.

## Native checks

```powershell
corepack pnpm nx run capture-workbench-desktop:cargo-fmt-check
corepack pnpm nx run capture-workbench-desktop:cargo-check
corepack pnpm nx run capture-workbench-desktop:cargo-test
corepack pnpm nx run capture-workbench-desktop:test-scripts
```

`cargo-check` and `cargo-test` first run `stage-deterministic-runtime` and point
the bundle resources at `src-tauri/target/deterministic-qa/staged`, so they work
on a fresh checkout without a staged product runtime in `src-tauri/binaries`.

## Runtime staging

Release automation must stage a Windows x64 runtime and its release manifest before the NSIS product build:

```powershell
node apps/capture-workbench-desktop/scripts/stage-runtime.ts `
  --artifact <capture-runtime.exe> `
  --manifest <capture-runtime-manifest.json> `
  --schema <capture-document-v2.schema.json> `
  --source release
corepack pnpm nx run capture-workbench-desktop:build-nsis
```

The ordinary `build` target compiles the Tauri app with `--no-bundle`.
`build-nsis` packages the staged release runtime using `tauri.conf.json`.

`build-nsis-deterministic` builds **Capture Workbench QA Fake Data** using
`tauri.deterministic-qa.conf.json` and the `acceptance-harness` Cargo feature.
Its identifier is `io.github.gx-capture.capture-workbench.deterministic-qa`.
The fake executable, manifest, schema and provenance are staged only under
`src-tauri/target/deterministic-qa/staged`; product resources are untouched.
Its separate Cargo output is `src-tauri/target/deterministic-qa`, with installers
in `x86_64-pc-windows-msvc/release/bundle/nsis` below that directory.
`hash-qa-installer` and the installed QA fixture smoke consume this QA installer.
The smokes drive the classic file dialog with window messages (`WM_SETTEXT` on
the file-name field, then `WM_COMMAND`/`IDOK`), without keyboard input or focus,
so that step also runs in a background session. A brokered (Explorer-hosted)
picker uses UI Automation with a keyboard fallback. Every keyboard send and
mouse click requires the picker to own the foreground root window; activation
is attempted once before refusing input, and a refused fallback exits with code 10.
The installer name, window title and build output label its fake runtime and fake data.
These artifacts must never be published as product releases.

The QA executable requires existing `E2E_ARTIFACT_ROOT` and
`CAPTURE_ACCEPTANCE_APP_DATA_ROOT` directories, with app data strictly below
the artifact root. The installed smoke creates them for each run;
`dev:deterministic` creates them under `src-tauri/target/deterministic-qa/dev`.
`capture-workbench-desktop:contract-consistency` checks that the fake's route
table covers the native host's method/path calls, including parameterized
routes. The pull-request `checks` job runs this gate.

## Opt-in real Ollama smoke

A user may prove a staged release runtime (`stage-product-runtime`) against one
real PDF and an existing app-data directory over the v2 ingestion and capture
flow (`POST /v2/ingestions`, chunked `PUT /v2/ingestions/{id}/chunks/{i}`,
`POST /v2/ingestions/{id}/finalize`, `POST /v2/captures`). This target is
excluded from normal CI and opens no window. When the directory lacks them, the
smoke installs the `windowsml-ocr` engine and the `qwen3.5-0.8b-v1` model
through the runtime; a directory the desktop app has already prepared needs no
download. Ollama itself must already be installed on `PATH` unless
`CAPTURE_REAL_SMOKE_ALLOW_OLLAMA_INSTALL=1` is set, in which case the runtime
installs `ollama-runtime` system-wide with `winget`:

```powershell
$env:CAPTURE_REAL_SMOKE_PDF = 'C:\path\to\user-provided.pdf'
$env:CAPTURE_REAL_SMOKE_APP_DATA = 'C:\prepared\Capture Workbench app-data'
corepack pnpm nx run capture-workbench-desktop:smoke-real-ollama
```

For a build that is not published yet, set
`CAPTURE_REAL_SMOKE_WORKER_MIRROR_URL` to a loopback mirror
(`http://127.0.0.1:<port>`) to opt into the local worker mirror. The smoke
records no source path, document content, bearer token, or mirror URL in its
evidence (`tmp/capture-workbench-desktop/real-ollama-smoke/real-ollama-smoke.json`).

## Opt-in staged-runtime three-media diagnostic

This preliminary diagnostic starts a staged runtime, then installs
`windowsml-ocr` and `speech-recognition` (forcing `cuda`) in host-controlled
order and exercises a real scanned PDF, image, and audio file over the v2
ingestion and capture flow (`POST /v2/ingestions`, chunked
`PUT /v2/ingestions/{id}/chunks/{i}`, `POST /v2/ingestions/{id}/finalize`,
`POST /v2/captures`, and `POST /v2/captures/{id}/structure/commit`) through
host structuring. It requires a complete approved catalog for an unused
successor version; immutable v0.3.8 fails closed before staging because both
dependencies are unavailable.

```powershell
$env:CAPTURE_REAL_MEDIA_PDF = 'C:\path\to\scanned.pdf'
$env:CAPTURE_REAL_MEDIA_IMAGE = 'C:\path\to\scan.png'
$env:CAPTURE_REAL_MEDIA_AUDIO = 'C:\path\to\listening.mp3'
$env:CAPTURE_REAL_MEDIA_APP_DATA = 'C:\prepared\Capture Workbench app-data'
corepack pnpm nx run capture-workbench-desktop:smoke-real-media
```

For a build that is not published yet, set
`CAPTURE_REAL_MEDIA_WORKER_MIRROR_URL` to a loopback mirror
(`http://127.0.0.1:<port>`) to opt into the local worker mirror
(`CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN=1` and `CAPTURE_ENGINE_CACHE_DIR=off`).
The diagnostic forwards `LOCALAPPDATA`, `TEMP`, and `USERNAME` to the runtime,
strips ambient provider/model overrides, verifies DirectML OCR and lock-selected
TEA-ASR provenance, proves UUID-scoped capture deletion, and checks its owned
runtime process is gone. Its report (`tmp/capture-workbench-desktop/real-media-smoke/real-media-smoke.json`)
always records `releaseGateSatisfied=false` and `consumerE2e=false`; it is not
candidate release evidence input.

## Real-engines localhost smoke

For the full application-level journey with real engines (installation, PDF and
image OCR, recording transcription with speaker identification, Ollama
structuring, edit/export/restore, and restart persistence), run the dev-server
smoke (`apps/capture-workbench-e2e/src/real-engines.spec.ts`):

```powershell
corepack pnpm nx run capture-workbench-e2e:smoke-real-engines
```

`smoke-real-media` forces the `cuda` pack and checks TEA-ASR 1.1 on CUDA;
`smoke-real-engines` checks the installed pack (`tea-asr-1.1` on `cuda` with the
NVIDIA driver, `tea-asr-1.1-mini` on `cpu` without it). A development
transcription outside them uses TEA-ASR 1.1 mini on CUDA, as
`.agents/RESEARCH/tea-asr-1.1-mini-gpu-2026-11-04.md` describes, by setting
`CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini` on the runtime. The desktop
GPU switch only selects the device; its fixed launch environment does not yet
expose the model setting.

To also check progressive audio, first record a reference with
`node apps/capture-workbench-desktop/scripts/progressive-audio-oracle.ts`
(`CAPTURE_PROGRESSIVE_AUDIO_ORACLE_SOURCE` and `_OUTPUT`), then pass the output
file as `CAPTURE_REAL_ENGINES_AUDIO_EXPECTATIONS` (or `CAPTURE_REAL_MEDIA_MODEL_AUDIO_ORACLE`).

## Installed QA fixture smoke

The installed QA fixture smoke (`smoke-installed-deterministic`) is intentionally opt-in because it performs a
silent, current-user NSIS install and uninstall:

```powershell
corepack pnpm nx run capture-workbench-desktop:smoke-installed-deterministic --skip-nx-cache
```

It refuses to run over an existing QA install,
uses an owned run directory below `tmp/capture-workbench-desktop/installed-smoke`, launches
WebView2 debugging with process-scoped environment variables, and uploads one
deterministic PDF, image, and audio fixture through the installed UI, plus a streamed,
run-local 52 MiB PCM WAV (48 kHz, 16-bit stereo; 180-second completion budget).
The large recording must complete, show its expected document and playback-unavailable
explanation, and never request source bytes. The fake request log proves 52 ordered
1 MiB chunks between ingestion creation and finalization, followed by capture creation;
no request may carry the whole recording. `installed-smoke.json` includes sorted,
unique `rendererIpcCommands` names only. WebView2 starts paused with `WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER`; an independent
CDP network recorder attaches before Playwright resumes startup and stays attached
through the entire UI exercise, including the refused probes. Successful plugin
calls fail the smoke. The window's capability grants no plugin permission, so the
probes include two core commands (`plugin:app|version`, `plugin:window|title`)
that must be refused. Cleanup
must prove that owned processes, the CDP port, install directory, registry
entries, and isolated data are gone before the target succeeds.

The native library uses `run/artifacts/appdata` via
`CAPTURE_ACCEPTANCE_APP_DATA_ROOT`; `E2E_ARTIFACT_ROOT` is `run/artifacts`.
The smoke selects each imported card by its newly appearing `data-document-id`.
Before installation it resolves real Roaming AppData through the Windows known
folder and records only product-directory/library existence and library-index
mtime/size. After process shutdown and uninstall it compares that metadata.
Any change fails isolation and appears in the failure report; no real library
contents are read, copied or logged. Failures are saved as timestamped
`installed-smoke-failure-*.json` files alongside the smoke evidence.

The resulting `tmp/capture-workbench-desktop/installed-smoke/installed-smoke.json`
is fixture evidence for this QA install and is diagnostic only. It does not certify
real OCR, speech recognition, structuring, or licensed-fixture behavior.

## Loopback ownership boundary

The sidecar interface accepts a runtime port number rather than an already-bound
socket, so the desktop host cannot hold a reservation while the runtime binds.
Startup mitigates that TOCTOU window with at most three attempts within one
60-second budget; every attempt uses a previously unused runtime port and a new
bearer token, and the runtime HTTP port is proven bound by the authenticated
readiness handshake. A failed attempt is stopped through its own Windows job
object before another attempt begins. Shutdown cancellation prevents further
attempts. On Windows the runtime root is created suspended, assigned to that
attempt's job object, and only then resumed, so a one-file bootloader child
cannot escape the ownership boundary before assignment.

The built-in Ollama's port is chosen by the runtime at each start, and the
runtime verifies that the listener is its own child before any HTTP or CLI call,
so the desktop host passes no Ollama address. The desktop host never kills an
unrelated process and never deletes the shared Ollama PID record; the runtime
lifecycle reconciles that record only after proving the recorded PID is no
longer alive, or that the PID now belongs to another process (its creation time
differs from the recorded one).
