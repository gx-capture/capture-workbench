// Maps capture operations and stored documents to activity, library status and display labels.
import type { CaptureOperation } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryStatus, DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import { isRecordingMediaType } from './capture-media-types';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';

/** Identifies non-terminal one-shot capture operations. */
export function isActiveOneShotOperation(operation: DesktopCaptureOperation): boolean {
  return operation.status === 'waiting_input'
    || operation.status === 'extracting'
    || operation.status === 'awaiting_structuring'
    || operation.status === 'structuring';
}

/** A one-shot OCR result is ready for host persistence before optional structuring. */
export function isOcrCheckpoint(operation: DesktopCaptureOperation): boolean {
  return operation.status === 'awaiting_structuring';
}

/** Identifies non-terminal streaming operations. */
export function isActiveStreaming(operation: CaptureOperation): boolean {
  return operation.status === 'waiting_input'
    || operation.status === 'extracting'
    || operation.status === 'awaiting_structuring'
    || operation.status === 'structuring';
}

/** The library statuses a capture can end in; `awaiting_confirmation` ends an OCR checkpoint. */
export type TerminalLibraryStatus = Extract<
  DesktopLibraryStatus,
  'completed' | 'failed' | 'canceled' | 'awaiting_confirmation'
>;

/** Maps a runtime terminal operation to the library's persisted status vocabulary. */
export function terminalLibraryStatus(operation: DesktopCaptureOperation): TerminalLibraryStatus {
  if (operation.status === 'completed') return 'completed';
  if (operation.status === 'cancelled') return 'canceled';
  return 'failed';
}

/**
 * The terminal library status a persisted runtime stage names, if the stage is
 * terminal for that media type: `awaiting_structuring` ends an OCR checkpoint,
 * and says nothing about how a recording ended.
 */
function terminalStatusFromStage(
  stage: string | undefined,
  mediaType: string,
): TerminalLibraryStatus | undefined {
  if (stage === 'completed') return 'completed';
  if (stage === 'cancelled') return 'canceled';
  if (stage === 'failed') return 'failed';
  if (stage === 'awaiting_structuring' && !isRecordingMediaType(mediaType)) {
    return 'awaiting_confirmation';
  }
  return undefined;
}

/**
 * How a row of an earlier version ended whose terminal data was saved but
 * whose runtime cleanup failed (`recovery_required` with
 * `runtime_cleanup_failed`; nothing writes it any more): the status its stage
 * names, or, for a stage that is not terminal, a stored error means failed and
 * a kept raw result completed. Undefined for every other row, and when the row
 * does not say; no status is guessed.
 */
export function committedTerminalStatus(
  document: DesktopLibrarySummary,
): TerminalLibraryStatus | undefined {
  if (document.status !== 'recovery_required' || document.recoveryCode !== 'runtime_cleanup_failed') {
    return undefined;
  }
  const namedByStage = terminalStatusFromStage(document.stage, document.mediaType);
  if (namedByStage) return namedByStage;
  if (document.errorCode) return 'failed';
  return document.hasRaw === true ? 'completed' : undefined;
}

/**
 * Imported and waiting for its capture: queued, without a runtime capture and
 * without a raw result. An earlier version's Start again stored `queued` and
 * kept the raw result; such a row is never captured again in place.
 */
export function isWaiting(document: DesktopLibrarySummary): boolean {
  return document.status === 'queued' && !document.captureId && document.hasRaw !== true;
}

/**
 * Whether the stored document says a capture was in progress, or needed
 * recovery, when no attempt of this app run owns it: the run that started it
 * ended (the app closed, the window reloaded) or this run's attempt ended
 * before its last write was stored. The link is only an address for cleanup
 * and is never followed. A terminal status is shown as it is, link or not.
 *
 * `persisting`, `recovery_required` and `capture_recovery_required` are read
 * here only because earlier versions stored them.
 */
export function isInterrupted(document: DesktopLibrarySummary, ownedByThisRun: boolean): boolean {
  if (ownedByThisRun) return false;
  switch (document.status) {
    case 'processing':
    case 'persisting':
      return true;
    case 'queued':
      return Boolean(document.captureId) || document.hasRaw === true;
    case 'recovery_required':
      return committedTerminalStatus(document) === undefined;
    case 'awaiting_confirmation':
      return document.hasRaw !== true || isRecordingMediaType(document.mediaType);
    case 'failed':
      return document.recoveryCode === 'capture_recovery_required';
    default:
      return false;
  }
}

/**
 * Whether the user's Start again may capture the stored document again: it
 * failed, was cancelled or was interrupted, and holds no raw result. A
 * document with a result is never captured again in place; to capture that
 * file again it is deleted and imported again.
 */
export function canStartAgain(document: DesktopLibrarySummary): boolean {
  if (document.hasRaw === true) return false;
  const status = committedTerminalStatus(document) ?? document.status;
  return status === 'failed' || status === 'canceled' || isInterrupted(document, false);
}

/** Maps a runtime stage to its workspace label. */
export function stageLabel(stage?: string): string {
  const labels = desktopMessages().stage;
  return labels[stage ?? ''] ?? labels['queued'] ?? '';
}
