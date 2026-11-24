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
smoke installs the `text-recognition` engine and the `qwen3.5-0.8b-v1` model
through the runtime; a directory the desktop app has already prepared needs no
download. Ollama itself must already be installed on `PATH` unless
`CAPTURE_REAL_SMOKE_ALLOW_OLLAMA_INSTALL=1` is set, in which case the runtime
installs `structuring-runtime` system-wide with `winget`:

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
`text-recognition` and `speech-recognition` (forcing `cuda`) in host-controlled
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
The Desktop App's loopback worker mirror and absolute local OCR model root
overrides are for verification only and each requires its explicit opt-in.
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
corepack pnpm nx run capture-workbench-e2e:smoke-real-engines-installation
corepack pnpm nx run capture-workbench-e2e:smoke-real-engines-execution
```

`smoke-real-media` forces the `cuda` pack and checks TEA-ASR 1.1 on CUDA;
`smoke-real-engines-execution` checks the installed pack (`tea-asr-1.1` on `cuda` with the
NVIDIA driver, `tea-asr-1.1-mini` on `cpu` without it). A development
transcription outside them uses TEA-ASR 1.1 mini on CUDA, as
`.agents/RESEARCH/tea-asr-1.1-mini-gpu-2026-11-04.md` describes, by setting
`CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini` on the runtime. The desktop
GPU switch only selects the device; its fixed launch environment does not yet
expose the model setting.

For the progressive partial check, use a recording longer than five minutes with speech after the checkpoint,
in a format the runtime decodes. Generate a digest-only
oracle with `node apps/capture-workbench-desktop/scripts/progressive-audio-oracle.ts`
using `CAPTURE_PROGRESSIVE_AUDIO_ORACLE_SOURCE` for the recording and
`CAPTURE_PROGRESSIVE_AUDIO_ORACLE_OUTPUT` for the JSON. Set
`CAPTURE_SPEECH_RECOGNITION_VARIANT` to the installed pack (`cuda` or `cpu`),
or use `auto` to select by NVIDIA driver availability. The generator uses the selected pack's default model and
device with CPU fallback disabled.

For `smoke-real-engines-execution`, set both
`CAPTURE_REAL_ENGINES_PROGRESSIVE_AUDIO` to that recording and
`CAPTURE_REAL_ENGINES_PROGRESSIVE_AUDIO_ORACLE` to its JSON oracle. The check
logs a skip when both are unset. `CAPTURE_REAL_ENGINES_AUDIO_EXPECTATIONS`
still supplies the expected text anchors for the separate speaker-identification
recording. A successful live check is recorded as `proven.progressivePartial`
with pack and extraction provenance in the smoke evidence.

Keep `CAPTURE_REAL_ENGINES_APP_DATA` and `CAPTURE_REAL_ENGINES_TEMP_DIR` outside
the workspace. The host copies source recordings into app data, and the temp
directory holds browser artifacts and exports. The runtime's engine cache
(under `LOCALAPPDATA/gx-capture/engine-cache` on Windows by default) must also
resolve outside the workspace.

The oracle installs the speech worker and model into a fresh kept run tree
(`.kept-run-trees/audio-oracle-<time>` beside the checkout) and leaves it there;
remove it when the machine is idle with
`corepack pnpm run kept-run-trees -- --remove <path>` (`-- --list` shows them).

## Installed QA fixture smoke

The installed QA fixture smoke (`smoke-installed-deterministic`) is intentionally opt-in because it performs a
silent, current-user NSIS install and uninstall:

```powershell
corepack pnpm nx run capture-workbench-desktop:smoke-installed-deterministic --skip-nx-cache
```

Every installed QA check (this smoke and the capture-lifecycle check below) holds one
lock per Windows account (by the SID of the process's access token, not by environment
variables) and QA product, in any worktree, from its preflight through its cleanup;
a second check refuses and names the one that holds it. Windows frees the lock when the
holding process ends. The QA checks also refuse to install without an installed
WebView2 Runtime (a valid version under the Evergreen runtime's registration, read as
`.github/actions/ensure-webview2` reads it), because the QA installer would install one
silently and its uninstaller would leave it behind.

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
records `evidenceKind: installed-nsis-smoke` and the installer source.
`deterministic` identifies the fixture-runtime QA build and `release` identifies
the release installer. Both reports are diagnostic. Real OCR, speech recognition
and structuring were not exercised.

## Installed QA capture-lifecycle check

The capture lifecycle's Desktop-only behaviour is checked on the installed QA build
(fixture runtime) by a manual target. It is a diagnostic, not a release gate, and
not part of verify or CI:

```powershell
corepack pnpm nx run capture-workbench-desktop:diagnostic-installed-deterministic-capture-lifecycle
```

It builds the QA installer first (`build-nsis-deterministic`). The check opens the
app's window and sends it input: F5 and Ctrl+R, the native file dialog, mouse
drags of files, and the title bar's close message. Leave the mouse and keyboard
alone until it ends. Keys go out only while the QA app's process (PID and start
time) owns the foreground, read as the last operation before they are sent; if the
foreground changes while they are sent, the run fails saying input may have reached
another window and sends nothing more. A drag aims at the app's drop area and counts
only when the button was released at the drop point over the app's window; the helper
always releases the button it pressed, also when a step fails, on its own deadline
and when the check asks it to stop. Only if the check has to kill the helper does it
say the left mouse button may need to be released by hand (click it once). It refuses
to run over an existing QA installation, without an installed WebView2 Runtime, while
another installed QA check holds the lock, and when a run tree of an earlier run is
still there.

It proves, in this order: F5 on the OCR page and Ctrl+R on the ASR page while a
capture runs reload the page, leave the row interrupted, write nothing and delete
only the stored capture link, and Start again completes; closing the app while a
capture runs ends every process of the app tree within 1 s (exit times read from
process handles opened before the close message) and leaves nothing by 1 s, 5 s and
15 s (each from a snapshot started 0.5 s earlier whose inventory returned by that
time; times are compared as measured); at the next start, recorded from before the
page's first script (WebView2 starts paused with `WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER`
at every launch), the row is interrupted, nothing is written, the page asks the host
once to delete exactly the stored link and the new runtime answers one DELETE with 204
or 404, and Start again completes; files dropped with native OLE drag and drop on the
OCR page, the ASR page and History are imported in drop order and captured one at a
time in that order: in the library writes, and in the fixture runtime's own log, where
a capture counts from the successful create that names it to the first successful read
of its outcome. A claim that does not hold fails the run by name; uninstall and cleanup
still run and report each step.

Everything stays below `tmp/capture-workbench-desktop/installed-capture-lifecycle`.
Before the first write, the workspace root and every folder down to the run tree must
be real folders, not links or junctions. The run tree is removed at the end of a
run only when no process of the run is left (before and after the uninstall), the
uninstaller removed the installation, no registry key remains and the real product app
data is unchanged; otherwise it is kept and the run fails. The evidence then lists
recovery steps for exactly what remains (processes to end, the uninstaller if it is
still in the tree, registry keys to delete) with workspace-relative paths, and the
command prints the tree's absolute path to stderr. A step runs or deletes something
only when the run verified it as its own: the uninstaller and the tree only while the
tree carries this run's marker and is still the directory the run made, a registry key
only in the view (32- or 64-bit) it was seen in and with the run's install directory
as its install location. For anything else, and for a run tree an earlier run left,
the steps say what to look at and why, and name nothing to run or delete. The check's own temporary directory
is removed in its cleanup phase, or by the command line's exit hook when the check
never got that far; both use the same removal, which leaves a directory in place when
its path or identity no longer proves the run made it. One
`installed-capture-lifecycle-<time>.json` per run records the outcome, the source
commit, the installer's name, size and SHA-256, each phase's claims and
observations, and the measured close times with their method; it passes only with
every expected claim proven. The window helpers are
`scripts/installed-window-input.ps1`, `scripts/installed-window-drop.ps1` and
`scripts/installed-app-tree.ps1`.

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
