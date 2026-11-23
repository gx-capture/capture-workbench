import type { DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import { canStartAgain, committedTerminalStatus, isInterrupted, isWaiting } from './capture-operation-status';

/** The five statuses the capture queues show. The pipeline stage is only a progress step. */
export type CaptureUserStatus =
  | 'waiting'
  | 'processing'
  | 'done'
  | 'needs-attention'
  | 'cancelled';

export type CaptureStatusChipVariant = 'running' | 'waiting' | 'done' | 'error';

/** What a row is shown from: the stored document and what this app run does with it. */
export interface CaptureRowInput {
  readonly document: DesktopLibrarySummary;
  /** An attempt of this app run captures the document (`busyIds`). */
  readonly owned: boolean;
  /** This run's Cancel of that attempt is being applied (`cancellingIds`). */
  readonly cancelling?: boolean;
  /** This run could not store the document's start or cancel (`unstoredOutcomes`). */
  readonly unstored?: boolean;
  /** Why, when the row shows it: the error of that read or write (`unstoredOutcomes`). */
  readonly failureReason?: string | null;
}

/** The status and the actions of one document, the same in both queues, History and the result view. */
export interface CaptureRowState {
  readonly userStatus: CaptureUserStatus;
  readonly statusText: string;
  /** Stored as in progress, and no attempt of this run owns it. */
  readonly interrupted: boolean;
  /** Cancel: the attempt of this run, or a waiting document. */
  readonly canCancel: boolean;
  /** The Cancel was given and is being applied: it cannot be given twice. */
  readonly cancelling: boolean;
  readonly canStartAgain: boolean;
  /** The document holds a result to look at. */
  readonly canView: boolean;
  /** Shown done and holding the raw text: the text export has something to export. */
  readonly canExport: boolean;
  /**
   * Why this run could not start or end the document's capture, as the host's
   * error said: only on a row shown interrupted or passed by for that reason.
   */
  readonly failureReason: string | null;
}

/**
 * The row of a stored document. A document an attempt of this run owns is
 * processing; any other is shown by what is stored: one that says a capture
 * was in progress is interrupted, whatever link it keeps. Start again is
 * offered exactly when the stored document allows it (`canStartAgain`), and
 * for a waiting document whose start or cancel this run could not store:
 * such a row does not wait, the admission passes it by until the user acts.
 */
export function captureRowState(input: CaptureRowInput): CaptureRowState {
  const { document } = input;
  const messages = desktopMessages();
  if (input.owned) {
    const cancelling = input.cancelling === true;
    return {
      userStatus: 'processing',
      statusText: cancelling ? messages.captureStatusCancelling : messages.captureStatusProcessing,
      interrupted: false,
      canCancel: true,
      cancelling,
      canStartAgain: false,
      canView: false,
      canExport: false,
      failureReason: null,
    };
  }
  const interrupted = isInterrupted(document, false);
  const unstoredWaiting = input.unstored === true && isWaiting(document);
  // This run's reason explains only a row this run left interrupted or passed
  // by; a row showing a state of its own (done, cancelled, failed as stored)
  // is shown by what is stored, even when this run's write of it went wrong.
  const explainedByThisRun = interrupted || unstoredWaiting;
  const userStatus = explainedByThisRun ? 'needs-attention' : storedUserStatus(document);
  return {
    userStatus,
    statusText: interrupted ? messages.captureInterrupted : captureStatusText(userStatus),
    interrupted,
    canCancel: userStatus === 'waiting',
    cancelling: false,
    canStartAgain: unstoredWaiting || canStartAgain(document),
    canView: userStatus === 'done' || document.hasRaw === true,
    canExport: userStatus === 'done' && document.hasRaw === true,
    failureReason: explainedByThisRun ? input.failureReason ?? null : null,
  };
}

/** The status of a stored document no attempt of this run owns and that is not interrupted. */
function storedUserStatus(document: DesktopLibrarySummary): CaptureUserStatus {
  if (isWaiting(document)) return 'waiting';
  const status = committedTerminalStatus(document) ?? document.status;
  if (status === 'canceled') return 'cancelled';
  // A checkpoint on a recording is interrupted, so only a document's is done here.
  if (status === 'completed' || (status === 'awaiting_confirmation' && document.hasRaw === true)) {
    return 'done';
  }
  return 'needs-attention';
}

function captureStatusText(status: CaptureUserStatus): string {
  const messages = desktopMessages();
  switch (status) {
    case 'waiting':
      return messages.captureStatusWaiting;
    case 'processing':
      return messages.captureStatusProcessing;
    case 'done':
      return messages.captureStatusDone;
    case 'cancelled':
      return messages.captureStatusCancelled;
    default:
      return messages.captureStatusNeedsAttention;
  }
}

/** Maps a capture user status to its chip styling variant. */
export function captureStatusChipVariant(status: CaptureUserStatus): CaptureStatusChipVariant {
  switch (status) {
    case 'processing':
      return 'running';
    case 'done':
      return 'done';
    case 'needs-attention':
      return 'error';
    case 'waiting':
    case 'cancelled':
    default:
      return 'waiting';
  }
}

/** Returns the Tailwind CSS classes for the given chip variant. */
export function captureStatusChipClasses(variant: CaptureStatusChipVariant): string {
  switch (variant) {
    case 'running':
      return 'bg-secondary text-secondary-foreground';
    case 'waiting':
      return 'border border-border text-muted-foreground';
    case 'done':
      return 'bg-muted text-secondary-foreground';
    case 'error':
      return 'bg-destructive/10 text-destructive';
  }
}
