# Headless dev host: the Workbench renderer against the real backend on the dev server

Status: decided 2026-11-17 (product owner agreed to the approach of
[#418](https://github.com/gx-capture/capture-workbench/issues/418)). Design by Claude.

## Why

Verification has two layers (AGENTS.md "Verification in two layers"): the dev
server, frontend and backend, verifies whatever it can; the Desktop App is only
for what the dev server cannot prove. Until this decision the Workbench
renderer could meet a real backend only inside the packaged Desktop App,
because the host's logic (the document library, source import, capture start,
export, the owned runtime) lives in the Tauri process behind 41 commands. So
every check of "the application with real engines" needed a desktop build, a
window on the user's machine and an hour or more.

## Decision

A second executable, `capture-workbench-dev-host`, built from the same crate
(`apps/capture-workbench-desktop/src-tauri`) behind the Cargo feature
`dev-host`. It has no window and no WebView. It builds the same state the Tauri
application builds in `setup` (`LibraryStore`, `DesktopState`,
`SourceSelections`, `UploadCancellations`, the runtime assets), starts the same
owned capture runtime, and serves the host's commands over HTTP on loopback.
The localhost preview gets a "real backend" mode whose injected bridge forwards
`invoke(command, args)` to it.

One implementation, two transports: each command's body is a plain function
that takes the shared state by reference; the `#[tauri::command]` wrapper and
the dev host's dispatcher both call it. Nothing is reimplemented in Node.

### What is the same and what is replaced

| Command group | Dev host |
| --- | --- |
| `runtime_*`, `desktop_runtime_status`, `desktop_compute_status`, `desktop_set_prefer_gpu`, `library_list`, `library_get`, `library_update_capture`, `library_save_edits`, `library_export`, `library_source_bytes`, `library_delete`, `library_import_selection`, `library_discard_selections` | the same function as the Tauri command |
| `library_select_sources` (native file dialog) | no dialog: it takes the paths a test queued through the dev endpoint `POST /__dev/selection` and inspects them with the same `SourceSelections::inspect_batch`; an empty queue answers like a cancelled dialog |
| `library_watch_native_sources` (drag and drop of native paths) | accepted, never delivers an event |
| `desktop_acceptance_close_window`, the feature-gated acceptance and model-smoke commands | not served |

The replaced rows are exactly what stays in layer 2: native dialogs, drag and
drop, window behaviour.

### HTTP surface (loopback only)

- `POST /invoke/<command>` with the arguments object as JSON (the same object
  the renderer passes to `invoke`). Success: `200` with the JSON value, or
  `application/octet-stream` for a command that returns bytes
  (`library_source_bytes`). A command's `Err(String)`: `400` with
  `{"error": "<the string>"}`, which the bridge rejects with, as Tauri does.
  Unknown command: `404`.
- `POST /__dev/selection` queues paths for the next `library_select_sources`.
  `GET /__dev/health` answers when the server is up. `POST /__dev/shutdown`
  stops the owned runtime the way a window close does, then the process.
- The server binds `127.0.0.1` only. Every request needs
  `Authorization: Bearer <token>`; the token comes from the environment
  (`CAPTURE_DEV_HOST_TOKEN`, required, at least 32 characters) and is never
  logged. The `Host` header must name the bound loopback address. No CORS
  headers: a browser never calls the dev host, the preview server does and adds
  the token there, so the token never reaches a page.
- At most 64 connections are in flight. A further connection is closed without
  being read. A socket whose read or write timeout cannot be set is closed.
  The listener is non-blocking. When accept would block, the loop waits about
  25 ms and checks shutdown again. Each accepted socket is set back to
  blocking, and is closed if that fails. A connection reads with a short
  timeout and keeps waiting until bytes arrive, 30 seconds have passed (for
  the headers, and again for the body) or the host is shutting down, so a
  client that sends nothing, or a byte now and then, holds a connection
  neither past that limit nor past shutdown. After the response the server
  stops sending and discards what the client still sends for at most a second
  before it closes: closing a socket with unread input makes Windows reset the
  connection, and the client could lose the response to a rejected request.
  Shutdown stops the owned runtime
  first, then waits for in-flight requests, then returns. Ctrl+C, Ctrl+Break
  and console close stop the runtime inside the console handler, because
  Windows may end the process a few seconds after a close handler returns. A
  panic in a request worker stops the host with an error that does not include
  the panic payload.
- Arguments: `--port <n>` (0 picks a free port; the chosen port is printed as
  one JSON line on stdout), `--app-data <absolute dir>` (required), and the
  runtime's manifest and executable paths (required; the staged runtime under
  `src-tauri/binaries` and `resources`, or a published release's files).
- `--app-data` is refused when it is the product directory or a directory
  inside it. On Windows the forbidden roots are `<Roaming>\<identifier>` and
  `<Local>\<identifier>`. Roaming and Local come from the known-folder API
  (`dirs::data_dir` and `dirs::data_local_dir`), the same folders the Tauri
  product uses. `APPDATA` and `LOCALAPPDATA` are extra forbidden roots when
  they are set and absolute. If either known folder cannot be resolved, or any
  forbidden root cannot be resolved to a comparable directory, the host does
  not start. Comparison is by directory identity: on Windows the volume serial
  number and file index from `GetFileInformationByHandle`, and device and inode
  elsewhere. A directory on the path whose identity cannot be read, or a
  volume that reports no identity, also stops the host: choose another
  `--app-data`. A product directory that does not exist yet still refuses that
  path and its children, by the deepest existing ancestor plus the remaining
  path components (compared without regard to case on Windows).

### It cannot reach a product build

- The dev host is its own `[[bin]]` with `required-features = ["dev-host"]`;
  the dispatcher and the HTTP server exist only under that feature.
- `src/main.rs` (the product executable) fails to compile when the feature is
  on, so no build can produce a product executable that contains the server.
  The Nx target `cargo-check-product-refuses-dev-host` runs that check and
  passes only when cargo fails and its output says the product must not be
  built with `dev-host`.
- No packaging target enables the feature and the bundle configuration does not
  list the executable.

### The command list cannot drift

The list of commands is written once. The Tauri handler and the dispatcher are
both generated from it, and a test fails when a command registered with Tauri
is neither served nor explicitly listed as replaced or not served. The
feature-gated acceptance and model-smoke commands are a second list in the
same file, one group per feature, visible in every feature configuration. The
three Tauri handler configurations and the dev host's "never served" names are
generated from that list. Each of those names returns `UnknownCommand`.

## Preview real-backend mode (launcher, bridge, proxy)

`apps/capture-workbench-e2e/real-backend-server.ts` owns one `capture-workbench-dev-host` child process for a preview or Playwright run:

- **Launcher lifecycle**: creates an isolated app-data directory under the temp root, generates an ephemeral `>=32`-character bearer token in memory, starts `capture-workbench-dev-host` with `--port 0`, `--app-data`, and the staged deterministic fixture runtime paths (`CAPTURE_DEV_HOST_TOKEN` in env, `--quiet` suppressed to its single `{"port":N}` stdout line), serves the upstream dev/preview server in real-backend mode, and shuts down via `POST /__dev/shutdown`, child wait/tree-kill fallback, and app-data directory removal.
- **Injected bridge**: HTML responses inject a `window.__TAURI_INTERNALS__` + `window.isTauri` bridge implementing `invoke`, `transformCallback`, `unregisterCallback`, `convertFileSrc`, and `metadata` (`{ currentWindow: { label: 'main' } }`). Commands go to same-origin `POST /__host/invoke/<command>` (returning JSON or `ArrayBuffer` for `application/octet-stream`, rejecting with error text on 400 or clear error on 404); `library_watch_native_sources` sends a `{ id }` channel object and delivers no events; `/__preview` shows a short active-host status page (port only, never the token) and ignores scenario cookies.
- **Proxy boundary**: listening on `127.0.0.1` only, the proxy forwards only `POST /__host/invoke/<command>` -> `/invoke/<command>` and `POST /__host/selection` -> `/__dev/selection`, injecting `Authorization: Bearer <token>` and `Host: 127.0.0.1:<dev-host-port>` server-side while stripping any `Access-Control-Allow-*` response headers. It rejects any request that fails `Host` (`127.0.0.1:<port>` or `localhost:<port>`), optional `Origin` (exact launcher origin), optional `Sec-Fetch-Site` (`same-origin` or `none`), `POST`, `Content-Type: application/json`, `X-Capture-Preview: 1`, or the `1 MiB` body cap with plain `400`/`403` without detail or CORS headers.

## Slices

1. **Rust**: the shared command functions, the
   dispatcher, the dev host executable, its tests against a fake runtime, Nx
   targets to build and test it, CI running those tests.
2. **Preview and e2e**: `apps/capture-workbench-e2e/real-backend-server.ts`
   with its `__TAURI_INTERNALS__` bridge and strict host proxy, paired with the
   `chromium-real-backend` Playwright project (`capture-workbench-e2e:e2e-real-backend`)
   that exercises the Workbench against `capture-workbench-dev-host` and the
   staged deterministic fixture runtime in CI.
3. **Real engines on localhost**: a local smoke against the dev host with a
   published runtime (first run with real downloads, PDF and image OCR, a
   recording with structuring, editing, export, data still there after a
   restart of the host). The Desktop App checks this replaces leave the desktop
   smokes and the acceptance list; the release runbook records the split.

## Rejected

- **A Node reimplementation of the host commands.** It would drift from the
  Rust implementation, and the point is to verify that implementation.
- **Forwarding to a packaged app with a hidden window over CDP.** Still a
  desktop build and a running Desktop App; the window is hidden, not absent.
- **Running the real commands through Tauri's mock runtime.** It keeps Tauri's
  IPC in the path without a WebView, but a browser on the dev server cannot
  speak that IPC, so a second transport is needed anyway.
