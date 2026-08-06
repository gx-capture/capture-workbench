# Capture Workbench Desktop

This Tauri 2 app is the Windows 11 x64, local-first Capture Workbench product.
It owns the user's private source/result library and starts one verified
Capture Runtime sidecar with a memory-only bearer token.

The desktop host starts one verified `capture-runtime` sidecar on a random loopback port with a memory-only 256-bit bearer token. Its product provider is an isolated Ollama lane with dedicated app data, model storage, port, profile, and PID file.

Run `corepack pnpm dev` for the product lane. It generates and stages release
runtime assets before Tauri starts. `corepack pnpm dev:deterministic` remains a
diagnostic-only test lane and never proves real engines or Ollama.

## Native checks

```powershell
corepack pnpm nx run capture-workbench-desktop:cargo-fmt-check
corepack pnpm nx run capture-workbench-desktop:cargo-check
corepack pnpm nx run capture-workbench-desktop:cargo-test
corepack pnpm nx run capture-workbench-desktop:package-qa-test
```

## Runtime staging

Release automation must stage a Windows x64 runtime and its release manifest before the NSIS product build:

```powershell
node apps/capture-workbench-desktop/scripts/stage-runtime.ts `
  --artifact <capture-runtime.exe> `
  --manifest <capture-runtime-manifest.json> `
  --schema <capture-document-v1.schema.json> `
  --source release
corepack pnpm nx run capture-workbench-desktop:build-nsis
```

The ordinary `build` target compiles the Tauri app with `--no-bundle` so workspace-wide verification does not silently package a fake runtime. `stage-deterministic-runtime` and `build-nsis-deterministic` are test-only and are not publication artifacts.

## Opt-in real Ollama smoke

After the first-run wizard has prepared an isolated app-data directory, a user may prove a
staged release runtime against one real PDF. This target is excluded from normal CI and never
downloads a model itself:

```powershell
$env:CAPTURE_REAL_SMOKE_PDF = 'C:\path\to\user-provided.pdf'
$env:CAPTURE_REAL_SMOKE_APP_DATA = 'C:\prepared\Capture Workbench app-data'
corepack pnpm nx run capture-workbench-desktop:smoke-real-ollama
```

It accepts only that source PDF and records no source path or bearer token in its evidence.

## Opt-in staged-runtime three-media diagnostic

This preliminary diagnostic starts a staged runtime, then installs
`windowsml-ocr` and `whisper-primary` in host-controlled order and exercises a
real scanned PDF, image, and audio file through host structuring. It requires a
complete approved catalog for an unused successor version; immutable v0.3.8
fails closed before staging because both dependencies are unavailable.

```powershell
$env:CAPTURE_REAL_MEDIA_PDF = 'C:\path\to\scanned.pdf'
$env:CAPTURE_REAL_MEDIA_IMAGE = 'C:\path\to\scan.png'
$env:CAPTURE_REAL_MEDIA_AUDIO = 'C:\path\to\listening.mp3'
$env:CAPTURE_REAL_MEDIA_APP_DATA = 'C:\prepared\Capture Workbench app-data'
corepack pnpm nx run capture-workbench-desktop:smoke-real-media
```

The diagnostic strips ambient provider/model overrides, verifies DirectML OCR
and lock-selected Whisper provenance, proves UUID-scoped capture deletion, and
checks its owned runtime process is gone. Its report always records
`releaseGateSatisfied=false` and `consumerE2e=false`: it is not the pending
Tauri/WebView scanned-PDF/image/audio acceptance harness and is not candidate
release evidence input.

## Opt-in real model-enabled Tauri/WebView gate

`smoke-real-media-model` is the local release-gated three-media harness. It launches
the packaged Tauri WebView with fresh app-data, performs consented catalog
installation, imports the project-owned scanned PDF and image plus a private
local audio fixture through the UI, and verifies raw/result,
provenance, DirectML OCR, lock-selected Whisper segments, UUID-scoped deletion,
and owned process cleanup. The report is redacted by construction and records
`releaseGateSatisfied=true` and `consumerE2e=false`.

```powershell
$env:CAPTURE_REAL_MEDIA_MODEL_AUDIO = 'C:\path\to\private-audio.mp3'
corepack pnpm nx run capture-workbench-desktop:smoke-real-media-model
```

The PDF and image are the lock-pinned project fixtures; only the packaged
executable can be overridden for local runs with
`CAPTURE_REAL_MEDIA_MODEL_EXECUTABLE`. The gate fails closed unless the staged
generated catalog and source lock are the approved 0.3.11 model-enabled
contract.

## Installed deterministic smoke

The installed deterministic smoke is intentionally opt-in because it performs a
silent, current-user NSIS install and uninstall:

```powershell
corepack pnpm nx run capture-workbench-desktop:smoke-installed-deterministic --skipNxCache
```

It refuses to run over an existing Capture Workbench install,
uses only an owned directory below `tmp/capture-workbench-desktop`, launches
WebView2 debugging with process-scoped environment variables, and uploads one
deterministic PDF, image, and audio fixture through the installed UI. Cleanup
must prove that owned processes, the CDP port, install directory, registry
entries, and isolated data are gone before the target succeeds.

The resulting `tmp/capture-workbench-desktop/installed-smoke/installed-smoke.json`
is explicitly marked deterministic and diagnostic only. It does not certify
real WindowsML, Whisper, Ollama, or licensed-fixture behavior.

## Loopback ownership boundary

The current sidecar interface accepts port numbers rather than already-bound
sockets. The desktop host therefore cannot hold a reservation while the runtime
binds. Startup mitigates that TOCTOU window with at most three attempts within
one 60-second budget; every attempt uses previously unused runtime/Ollama ports
and a new bearer token. A failed attempt is stopped through its own Windows job
object before another attempt begins. The desktop host never deletes the shared
Ollama PID record; the runtime lifecycle reconciles it only after proving the
recorded PID is no longer alive. Shutdown cancellation prevents further attempts.
On Windows the runtime root is created suspended, assigned to that attempt's
job object, and only then resumed, so a one-file bootloader child cannot escape
the ownership boundary before assignment.

The runtime HTTP port is proven bound by the authenticated readiness handshake.
The isolated Ollama port can still be claimed by another process after runtime
readiness but before Ollama is started later. Fully eliminating that late-bind
race requires a future runtime contract that accepts an inherited socket (or
performs its own bind-and-launch recovery); the desktop host never resolves it by
killing an unrelated process.
