# Source selection owned by the native side (issue #155, slice 6)

Slice 6 of [large-recording-import.md](large-recording-import.md). The renderer stops handling file paths: Rust opens the file dialog and receives native drops, and the renderer gets opaque selection tokens with a base name, a size and a media type. Importing consumes a token.

## Verified facts about the Tauri version in use

tauri 2.12.5, tauri-runtime-wry 2.12.3, wry 0.57.1, tauri-plugin-dialog 2.8.4 (`apps/capture-workbench-desktop/src-tauri/Cargo.lock`). Read in the crate sources; line numbers refer to those versions.

- **A native drop cannot be vetoed.** wry installs its own drop target and collects the paths (`wry/src/webview2/drag_drop.rs`). Tauri core emits `tauri://drag-enter` and `tauri://drag-drop` with `paths` to the window before any application handler runs (`tauri/src/manager/window.rs:205-277`); there is no hook to stop it. Rust can observe the same drop through `Builder::on_window_event` and `WindowEvent::DragDrop`.
- **The emit reaches JavaScript only through a registered listener.** Script is evaluated only for listener ids created by `plugin:event|listen` (`tauri/src/event/listener.rs`, `tauri/src/manager/mod.rs:548-576`). If the renderer may not call `listen`, no path reaches the webview.
- **Listening cannot be limited by event name.** `core:event:default` (part of `core:default`) allows `listen`, `unlisten`, `emit` and `emit-to`; the `listen` command takes no scope (`tauri/src/event/plugin.rs`). A deny overrides an allow. A `tauri::ipc::Channel` keeps working with every event permission denied.
- **The capability file does not fence application commands.** Only `core` and plugin commands are checked against the access list. An application command that takes a path stays reachable for as long as it is registered, so it must be removed, not merely left without a caller.
- **The dialog can be opened from Rust**: `app.dialog().file().set_parent(&window).add_filter(..).blocking_pick_files()` returns `Option<Vec<FilePath>>`. The blocking form must not run on the main thread; an `async` command with the existing `run_blocking` helper is right. The renderer's `dialog:allow-open` permission and the `@tauri-apps/plugin-dialog` npm dependency are then no longer needed; `tauri_plugin_dialog::init()` stays.
- The only renderer code that subscribes to events is the drop handling in `apps/capture-workbench/src/app/services/desktop-library.service.ts`.

Not verified: what WebView2 delivers when `dragDropEnabled` is `false` (the fallback below); whether a mapped network drive canonicalizes to a UNC path.

## Design

Slice 6 moves all three entry points (workspace picker, OCR picker, drop) to tokens and removes `library_import_source`. Once Rust owns the dialog and the drop, the renderer has no path left to queue, and leaving the path command registered would keep an arbitrary-path IPC reachable.

### Contracts (`src-tauri/src/contracts/selection.rs`, camelCase, requests deny unknown fields)

```rust
enum SourceSelectionKind { Documents, All }
struct LibrarySelectSourcesRequest { kind: SourceSelectionKind }
struct LibrarySourceSelection { selection_token: String, file_name: String, byte_length: u64, media_type: String }
enum SourceRejectionReason { Unsupported, Empty, TooLarge, NotRegularFile, NotLocal, Unreadable, LimitReached }
struct LibrarySourceSelectionBatch { selections: Vec<LibrarySourceSelection>, rejected: Vec<SourceRejectionReason> }
struct LibraryImportSelectionRequest { selection_token: String, capture_options: Option<LibraryCaptureOptions> }
struct LibraryDiscardSelectionsRequest { selection_tokens: Vec<String> }
```

A rejection carries a reason code only, never a name or a path; the renderer turns the codes into messages.

### Registry (`src-tauri/src/source_selection.rs`, managed state next to the library store)

- A selection holds the **open file handle**, the base name, the length and the media type sniffed from the prefix. No path is kept after inspection. The handle keeps pointing at the file the user chose even if the original is renamed or replaced, which closes the race between selection and import.
- Tokens: 32 lowercase hex characters from 16 random bytes (the library's existing id helper), checked for shape before lookup.
- Bound to the window label. `take` removes the entry, so a token works once. Unknown, malformed, expired, consumed and other-window tokens all get the same answer, "Selected source is no longer available. Choose it again."; a wrong-window attempt leaves the entry for its owner.
- Expiry 30 minutes, at most 64 live selections; both enforced on every registry call with an injected clock (no background thread). Selections beyond the limit are reported as `LimitReached`.
- A destroyed window drops its selections and its drop channel.

### Inspection (blocking threads only)

1. `symlink_metadata`: reject symlinks, junctions and anything that is not a regular file.
2. `canonicalize`, then require a local disk path: the first component is a verbatim drive prefix. UNC, device and volume-GUID paths are `NotLocal`. A drive whose type is remote, unknown or without a root is also `NotLocal` (`GetDriveTypeW`, feature flags on the existing `windows-sys` dependency).
3. Open the canonical path once; take the length from the handle. Empty is `Empty`; over the limit for the kind (recordings 2 GiB, PDF and image 50 MiB) is `TooLarge`.
4. Read a prefix, check the base name, verify the signature against the extension. The `Documents` kind accepts PDF, PNG and JPEG only.

`LibraryStore::import_opened(source, options)` imports from the handle (slice 5's streaming copy) and fails with "Selected source changed during import." when the length or the signature no longer matches.

### Commands (all `async`; logic in plain functions so tests need no Tauri runtime)

| Command | Behavior |
|---|---|
| `library_select_sources(kind)` | Native dialog, one at a time ("A file dialog is already open." otherwise). Cancel returns an empty batch. |
| `library_watch_native_sources(on_event: Channel)` | Registers the window's channel for drop batches, replacing an earlier one. |
| `library_import_selection(token, capture_options)` | `take`, then `import_opened`. |
| `library_discard_selections(tokens)` | Idempotent; unknown tokens are ignored without an answer that reveals which exist. |

The drop hook in `lib.rs` handles `WindowEvent::DragDrop(Drop { paths })`: with no subscriber nothing happens; otherwise it inspects on a blocking thread, admits, and sends the batch through the channel. It does not use `app.listen("tauri://drag-drop")`, because the renderer could forge that event while `emit` is allowed.

Removed: the command `library_import_source` and its registration. `model_smoke_import_fixture` keeps resolving its fixture key inside Rust.

### Capability (`src-tauri/capabilities/default.json`)

```json
"permissions": ["core:event:deny-listen", "core:event:deny-unlisten",
  "core:event:deny-emit", "core:event:deny-emit-to", "dialog:deny-open",
  "dialog:deny-save", "dialog:deny-message", "dialog:deny-ask", "dialog:deny-confirm"]
```

The window is granted no plugin permission. `core:default` was dropped in slice 8 of the import plan after a packaged run recorded every IPC command the renderer invokes from WebView start: only the application's own commands, which need no permission, and a `Channel`, whose data fetch is exempt from the permission check. The denies stay so that adding a default set later cannot restore event listening or renderer dialogs silently. Never granted: `fs:*`, asset-protocol scopes, path-to-URL conversion.

### Renderer

- `DesktopLibraryService`: `selectSources(kind)` and `droppedSources()` return selection batches; `importSelection(selection, captureOptions?)` replaces `createSource` and `importSource`; `discardSelections(selections)`. The dialog and webview imports go.
- `DesktopTauriCommandService.watch(command, channelArg)` wraps a `Channel` so tests mock the service and never build one.
- `CaptureQueueStore` and `DesktopWorkspaceStore` hold selections instead of paths; names come from `fileName`; what they refuse is discarded.
- The workspace imports every selection of a batch first, then runs the captures in the same order: waiting for each capture before the next import would let later tokens expire during a long transcription. The documents that wait for their turn are held by the capture service, so the OCR queue, which starts queued documents on its own, does not start them early or twice.
- A message per rejection reason (zh-TW and en).

### Fallback if a packaged run shows a path can still reach JavaScript

Set `dragDropEnabled` to `false` for the window: Rust then sees no drops, the drop zone asks the user to choose files instead, and the page prevents the default action of `dragover` and `drop`.

## Tests

- Registry: forged, malformed, expired (and valid just before), wrong window, consumed twice, discard then take, the 65th selection, window destroyed, identical failure messages.
- Inspection: accepted PDF; empty; oversize (sparse file); directory; symlink; extension and signature mismatch; a recording under `Documents`; local-path cases for drive, UNC, device and volume-GUID prefixes.
- Commands as plain functions: the original renamed and replaced after selection still imports the chosen bytes; truncation after selection fails; a request with `sourcePath` does not deserialize; a drop batch carries base names only; no subscriber, no selections.
- Renderer: command arguments carry `selectionToken` and never a path; refused selections are discarded; drop routing; the second selection is imported before the first capture finishes.
- The source-text assertions about the dialog and drop plumbing in `apps/capture-workbench-desktop/scripts/desktop-contract.test.ts` become a data assertion on the parsed capability file and the command list.
- Packaged check (a step of `capture-workbench-desktop:smoke-installed-deterministic`, which needs an interactive desktop): from the page, `plugin:event|listen` for the drag events, `plugin:dialog|open`, the core commands `plugin:app|version` and `plugin:window|title`, `library_import_source` and `library_import_selection` with a forged token are all refused; no `plugin:*` command succeeds at any point of the session; during a picker import no IPC request or response contains the fixture directory. The IPC is recorded from the network (requests to `ipc.localhost`): the webview defines `__TAURI_INTERNALS__.invoke` as read-only, so it cannot be wrapped. Picking a file and a real OS drag are checked by hand (issue #338).

## Open points

- OneDrive placeholder files are accepted; opening one downloads it, which can be slow.
- A batch imports every selection before its first capture starts, so only the import copies count against the 30-minute expiry; many multi-GiB recordings on a slow disk could still outlast it.
