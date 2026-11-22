// Maps capture operations and stages to activity, library status and display labels.
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
 * Whether the stored document holds the terminal data of its capture, so that
 * only the runtime cleanup is left to do: it is stored as ended, as an OCR
 * result to confirm, or as a refused cleanup.
 */
export function holdsTerminalData(document: DesktopLibrarySummary): boolean {
  return document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled'
    || (document.status === 'awaiting_confirmation' && document.hasRaw === true)
    || document.recoveryCode === 'runtime_cleanup_failed';
}

/**
 * The terminal status the stored document says its capture ended in: its own
 * terminal status, or, while only the runtime cleanup is still to do, the one
 * its stage names (`awaiting_structuring` only for OCR media). Earlier versions
 * stored the cleanup row of a recording with the last event's stage, which need
 * not be terminal (or could be `awaiting_structuring`); then the document's own
 * data decides: a stored terminal error means failed, a kept result completed.
 * Undefined when the document does not say; no status is guessed.
 */
export function committedTerminalStatus(
  document: DesktopLibrarySummary,
): TerminalLibraryStatus | undefined {
  if (
    document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled'
  ) {
    return document.status;
  }
  if (document.status === 'awaiting_confirmation' && document.hasRaw === true) {
    return 'awaiting_confirmation';
  }
  if (document.recoveryCode !== 'runtime_cleanup_failed') return undefined;
  const namedByStage = terminalStatusFromStage(document.stage, document.mediaType);
  if (namedByStage) return namedByStage;
  if (document.errorCode) return 'failed';
  return document.hasRaw === true ? 'completed' : undefined;
}


/** Converts a library terminal status to the runtime stage spelling. */
export function terminalStage(status: TerminalLibraryStatus): string {
  if (status === 'canceled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'awaiting_confirmation') return 'awaiting_structuring';
  return 'completed';
}

/**
 * Whether the stored document says its capture was lost: it was interrupted
 * without a runtime capture, or its runtime capture could not be found again.
 * These are the states in which a queue row offers a restart.
 */
export function isCaptureLost(document: DesktopLibrarySummary): boolean {
  if (document.status === 'processing' || document.status === 'persisting') {
    return !document.captureId;
  }
  return (document.status === 'failed' || document.status === 'recovery_required')
    && document.recoveryCode === 'capture_recovery_required';
}

/**
 * Whether a document without a runtime capture can be captured again when the
 * user asks: the states in which a queue row offers retry or restart. A
 * waiting document starts by itself, and a document that holds its result is
 * finished.
 */
export function canCaptureAgain(document: DesktopLibrarySummary): boolean {
  return document.status !== 'queued'
    && document.status !== 'completed'
    && !(document.status === 'awaiting_confirmation' && document.hasRaw === true);
}

/** Maps a runtime stage to its workspace label. */
export function stageLabel(stage?: string): string {
  const labels = desktopMessages().stage;
  return labels[stage ?? ''] ?? labels['queued'] ?? '';
}
