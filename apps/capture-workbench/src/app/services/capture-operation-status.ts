// Maps capture operations and stages to activity, library status and display labels.
import type { CaptureOperation } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryStatus, DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
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

/** The terminal library status a persisted runtime stage names, if the stage is terminal. */
function terminalStatusFromStage(stage?: string): TerminalLibraryStatus | undefined {
  if (stage === 'completed') return 'completed';
  if (stage === 'cancelled') return 'canceled';
  if (stage === 'failed') return 'failed';
  if (stage === 'awaiting_structuring') return 'awaiting_confirmation';
  return undefined;
}

/**
 * The terminal status whose data the stored document already holds: its own
 * terminal status, or, while only the runtime cleanup is still to do, the one
 * its stage names. Undefined when the document does not say: then the runtime
 * capture is asked, and no status is guessed.
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
  return document.recoveryCode === 'runtime_cleanup_failed'
    ? terminalStatusFromStage(document.stage)
    : undefined;
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
