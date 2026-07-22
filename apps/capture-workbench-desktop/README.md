# Capture Workbench Desktop Harness

This Tauri 2 app is the Windows 11 x64 packaging and clean-install verification host for Capture Workbench. It is intentionally not the public desktop product.

The harness starts one verified `capture-runtime` sidecar on a random loopback port with a memory-only 256-bit bearer token. Its default development provider is an isolated Ollama lane with dedicated app data, model storage, port, profile, and PID file.

From a fresh checkout, run `pnpm dev`. The root script uses the
`dev-deterministic` target, which stages test-only runtime assets before Tauri
starts. To exercise explicitly staged real runtime assets instead, stage them
first and run `pnpm dev:staged-runtime`; that path never stages a fake for you.

## Native checks

```powershell
pnpm nx run capture-workbench-desktop:cargo-fmt-check
pnpm nx run capture-workbench-desktop:cargo-check
pnpm nx run capture-workbench-desktop:cargo-test
pnpm nx run capture-workbench-desktop:package-qa-test
```

## Runtime staging

Release automation must stage a Windows x64 runtime and its release manifest before `build`:

```powershell
node apps/capture-workbench-desktop/scripts/stage-runtime.mjs `
  --artifact <capture-runtime.exe> `
  --manifest <capture-runtime-manifest.json> `
  --schema <capture-document-v1.schema.json> `
  --source release
pnpm nx run capture-workbench-desktop:build-nsis-release
```

The ordinary `build` target compiles the Tauri app with `--no-bundle` so workspace-wide verification does not silently package a fake runtime. `stage-deterministic-runtime` and `build-nsis-deterministic` are test-only; their outputs cannot be used as clean-install or release evidence.

## Installed deterministic smoke

The installed harness check is intentionally opt-in because it performs a
silent, current-user NSIS install and uninstall:

```powershell
pnpm nx run capture-workbench-desktop:smoke-installed-deterministic --skipNxCache
```

It refuses to run over an existing Capture Workbench Verification install,
uses only an owned directory below `tmp/capture-workbench-desktop`, launches
WebView2 debugging with process-scoped environment variables, and uploads one
deterministic PDF, image, and audio fixture through the installed UI. Cleanup
must prove that owned processes, the CDP port, install directory, registry
entries, and isolated data are gone before the target succeeds.

The resulting `tmp/capture-workbench-desktop/installed-smoke/installed-smoke.json`
is explicitly marked deterministic and non-releaseable. It does not replace
the protected Windows 11 clean-install lane with real WindowsML, Whisper,
Ollama, and licensed fixtures.

## Loopback ownership boundary

The current sidecar interface accepts port numbers rather than already-bound
sockets. The harness therefore cannot hold a reservation while the runtime
binds. Startup mitigates that TOCTOU window with at most three attempts within
one 60-second budget; every attempt uses previously unused runtime/Ollama ports
and a new bearer token. A failed attempt is stopped through its own Windows job
object before another attempt begins. The harness never deletes the shared
Ollama PID record; the runtime lifecycle reconciles it only after proving the
recorded PID is no longer alive. Shutdown cancellation prevents further attempts.
On Windows the runtime root is created suspended, assigned to that attempt's
job object, and only then resumed, so a one-file bootloader child cannot escape
the ownership boundary before assignment.

The runtime HTTP port is proven bound by the authenticated readiness handshake.
The isolated Ollama port can still be claimed by another process after runtime
readiness but before Ollama is started later. Fully eliminating that late-bind
race requires a future runtime contract that accepts an inherited socket (or
performs its own bind-and-launch recovery); the harness never resolves it by
killing an unrelated process.
