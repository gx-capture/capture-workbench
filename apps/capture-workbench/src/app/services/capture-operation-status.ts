// Maps capture operations and stages to activity, library status and display labels.
import type { CaptureOperation } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryStatus, DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';

/** Identifies non-terminal one-shot capture operations. */
export function isActiveOneShotOperation(operation: DesktopCaptureOperation): boolean {
  return operation.status === 'created'
    || operation.status === 'waiting_input'
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
  return operation.status === 'created'
    || operation.status === 'waiting_input'
    || operation.status === 'extracting'
    || operation.status === 'awaiting_structuring'
    || operation.status === 'structuring';
}

/** Maps a runtime terminal operation to the library's persisted status vocabulary. */
export function terminalLibraryStatus(operation: DesktopCaptureOperation): DesktopLibraryStatus {
  if (operation.status === 'completed') return 'completed';
  if (operation.status === 'cancelled') return 'canceled';
  return 'failed';
}

/** Derives a terminal library status from a persisted runtime stage. */
export function terminalStatusFromStage(stage?: string): DesktopLibraryStatus {
  if (stage === 'cancelled') return 'canceled';
  if (stage === 'failed') return 'failed';
  if (stage === 'awaiting_structuring') return 'awaiting_confirmation';
  return 'completed';
}

/** Indicates whether a document already contains terminal data during recovery. */
export function hasCommittedTerminalData(document: DesktopLibrarySummary): boolean {
  return document.recoveryCode === 'runtime_cleanup_failed'
    || document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled';
}

/** Preserves an existing terminal status while recovering runtime cleanup. */
export function committedTerminalStatus(document: DesktopLibrarySummary): DesktopLibraryStatus {
  return document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled'
    ? document.status
    : terminalStatusFromStage(document.stage);
}

/** Converts a library terminal status to the runtime stage spelling. */
export function terminalStage(status?: DesktopLibraryStatus): string {
  if (status === 'canceled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'awaiting_confirmation') return 'awaiting_structuring';
  return 'completed';
}

/** Maps a runtime stage to its workspace label. */
export function stageLabel(stage?: string): string {
  const labels = desktopMessages().stage;
  return labels[stage ?? ''] ?? labels['queued'] ?? '';
}
