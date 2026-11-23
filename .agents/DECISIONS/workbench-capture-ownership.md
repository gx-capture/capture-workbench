# Workbench capture ownership

Status: decided 2026-11-22.

A capture belongs to the app run that started it. The Workbench only tracks captures it created in the current run; a stored runtime capture link from an earlier run is never followed and serves only as an address for best-effort deletion.

## Why

- Runtime captures are ephemeral: the runtime does not resume unfinished captures after it stops and prunes them after 24 hours.
- Runtime `DELETE` stops the worker first and then removes the capture.
- The source file stays in the library, so any capture can be started again.
- Keeping ephemeral captures durable across failures on both sides made one service change thirty times in a day, with each review finding a gap next to the last fix.

## Rules

1. **No reattach**: a stored link is only an address for deletion, never polled or resumed across reloads or restarts.
2. **Cancel is a runtime delete**: cancelling a running capture with a known capture ID sends one `DELETE` to the runtime first (there is no cancel request) and writes `canceled` after it answers or times out; cancelling before a capture ID exists cancels any upload in progress at the host, and no capture `DELETE` is sent while the ID is unknown; an ID the runtime returns after the Cancel is deleted once and never linked to the row; cancelling a waiting row only updates the library.
3. **One terminal write, untracked cleanup**: each attempt ends with one library write; after it, an unawaited, untracked runtime `DELETE` is sent only if a capture ID exists, cancel did not already send `DELETE`, and the runtime is ready.
4. **A failure ends the attempt**: nothing retries by itself; the user restarts or cancels.
5. **A row with raw text is never captured again in place**: delete the document and import the file again.
6. **One capture at a time in import order**: one admission in `DesktopCaptureService` starts captures for documents and recordings together.

## Given up

- A capture in progress when the app closes, crashes, or reloads its window (`F5` / `Ctrl+R`, also in the packaged app) must be started again by the user.
- A result that was finished but not yet saved (close, disk error) is computed again.
- A cancel the runtime could not be reached for still stores `canceled` (clearing the link) if the library write succeeds—if that write fails, the row keeps its last committed state and link; when cancel and completion race, cancel wins and the result is not kept; a cancel after the terminal write is sent has no effect.
- Partial OCR text and the evidence record of a cancelled or failed attempt are not kept.
- A document holding raw text cannot be captured again in place.

## Known leftovers

- A reload during an upload can leave a capture the library never learned of (it runs to completion unseen until 24-hour retention removes it).
- A runtime delete that is refused or times out leaves the capture at the runtime, and the old worker may still run while the next capture starts.
- When reading the stored link fails during a delete, the delete proceeds with the link from the displayed list, so a capture linked after the list loaded can stay at the runtime until retention removes it.

## Not built on purpose

- Startup writes that normalise rows, a run fence or generation checks in the host, host-side holding of capture IDs across a reload, a compensating cancel, a reset of a document that holds a result, disabling the window's reload keys.

## Evidence

- Dev-host journeys: `apps/capture-workbench-e2e/src/capture-lifecycle.dev-host.spec.ts`
- Capture service spec: `apps/capture-workbench/src/app/services/desktop-capture.service.spec.ts`
- Host library rules: `apps/capture-workbench-desktop/src-tauri/src/library.rs` (cargo tests `awaiting_confirmation_stores_raw_and_completed_evidence_in_one_write`, `different_second_ocr_evidence_fails_closed`, and `linked_document_with_capture_id_can_be_deleted`)
