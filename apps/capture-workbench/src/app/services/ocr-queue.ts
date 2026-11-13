import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { isActiveJob, stageLabel } from './desktop-workspace.selectors';

/** The five statuses the OCR queue shows. The pipeline stage is only a progress step. */
export type OcrUserStatus =
  | 'waiting'
  | 'processing'
  | 'done'
  | 'needs-attention'
  | 'cancelled';

export interface OcrQueueView {
  readonly documentId: string;
  readonly fileName: string;
  readonly pageLabel: string;
  readonly userStatus: OcrUserStatus;
  readonly statusText: string;
  readonly progressText: string;
  readonly needsInstall: boolean;
  readonly installPercent: number | null;
  readonly interrupted: boolean;
  readonly canExport: boolean;
}

/**
 * Queue order (#348): oldest import first, so a batch is shown and started in the order
 * it was selected. The library lists newest first, so documents imported in the same
 * millisecond keep the reverse of the library's order (the sort is stable).
 */
export function inImportOrder<T extends { readonly createdAtMs: number }>(documents: readonly T[]): T[] {
  return [...documents].reverse().sort((left, right) => left.createdAtMs - right.createdAtMs);
}

/** Pages `1..=count`, the only range this host sends. */
export function pdfPagePrefix(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

export function isOcrMediaType(mediaType: string): boolean {
  return mediaType === 'application/pdf'
    || mediaType === 'image/png'
    || mediaType === 'image/jpeg';
}

/** Blank means every page. Anything else must be a whole number from 1 to 500. */
export function parsePdfPageCount(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/u.test(trimmed)) return 'invalid';
  const count = Number(trimmed);
  if (count < 1 || count > 500) return 'invalid';
  return count;
}

export function ocrStatusText(status: OcrUserStatus): string {
  const messages = desktopMessages();
  switch (status) {
    case 'waiting':
      return messages.ocrStatusWaiting;
    case 'processing':
      return messages.ocrStatusProcessing;
    case 'done':
      return messages.ocrStatusDone;
    case 'cancelled':
      return messages.ocrStatusCancelled;
    default:
      return messages.ocrStatusNeedsAttention;
  }
}

/** `.txt` in page order. Pages are separated by a blank line. */
export function renderRawOcrText(raw: RawCapture | null | undefined): string {
  if (!raw) return '';
  const pages = new Map<number, { readonly order: number; readonly text: string }[]>();
  for (const segment of raw.segments) {
    if (segment.locator.kind !== 'page') continue;
    if (segment.text.trim() === '') continue;
    const group = pages.get(segment.locator.page) ?? [];
    group.push({ order: segment.order, text: segment.text });
    pages.set(segment.locator.page, group);
  }
  if (pages.size === 0) return raw.sourceText;
  return [...pages.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, segments]) => segments
      .sort((left, right) => left.order - right.order)
      .map((segment) => segment.text)
      .join('\n'))
    .join('\n\n');
}

export function describeOcrDocument(input: {
  readonly document: DesktopLibrarySummary;
  readonly job?: DesktopCaptureOperation;
  readonly busy: boolean;
  readonly ocrReady: boolean;
  readonly installPercent: number | null;
}): OcrQueueView {
  const { document } = input;
  const jobActive = input.job !== undefined && isActiveJob(input.job);
  const described = describeStatus(document, input.busy || jobActive);
  const waiting = described.userStatus === 'waiting';
  return {
    documentId: document.documentId,
    fileName: document.fileName,
    pageLabel: pageLabel(document, input.job),
    userStatus: described.userStatus,
    statusText: ocrStatusText(described.userStatus),
    progressText: described.userStatus === 'processing'
      ? progressText(input.job)
      : '',
    needsInstall: waiting && !input.ocrReady,
    installPercent: waiting && !input.ocrReady ? input.installPercent : null,
    interrupted: described.interrupted,
    canExport: described.userStatus === 'done' && document.hasRaw === true,
  };
}

function describeStatus(
  document: DesktopLibrarySummary,
  active: boolean,
): { readonly userStatus: OcrUserStatus; readonly interrupted: boolean } {
  if (active) return { userStatus: 'processing', interrupted: false };
  if (
    (document.status === 'processing' || document.status === 'persisting')
    && document.captureId
  ) {
    return { userStatus: 'processing', interrupted: false };
  }
  if (document.status === 'processing' || document.status === 'persisting') {
    return { userStatus: 'needs-attention', interrupted: true };
  }
  if (document.status === 'canceled') {
    return { userStatus: 'cancelled', interrupted: false };
  }
  if (document.status === 'failed' || document.status === 'recovery_required') {
    return {
      userStatus: 'needs-attention',
      interrupted: document.recoveryCode === 'capture_recovery_required',
    };
  }
  if (
    document.status === 'completed'
    || (document.status === 'awaiting_confirmation' && document.hasRaw === true)
  ) {
    return { userStatus: 'done', interrupted: false };
  }
  if (document.status === 'queued') {
    return { userStatus: 'waiting', interrupted: false };
  }
  return { userStatus: 'needs-attention', interrupted: false };
}

function pageLabel(
  document: DesktopLibrarySummary,
  job: DesktopCaptureOperation | undefined,
): string {
  if (document.mediaType === 'image/png' || document.mediaType === 'image/jpeg') {
    return '1';
  }
  if (typeof job?.pagesTotal === 'number') return String(job.pagesTotal);
  const chosen = document.captureOptions?.pdfPageCount;
  if (typeof chosen === 'number' && chosen >= 1) return String(chosen);
  return '—';
}

function progressText(job: DesktopCaptureOperation | undefined): string {
  if (!job) return '';
  const percent = typeof job.progress === 'number' && Number.isFinite(job.progress)
    ? Math.round(Math.min(Math.max(job.progress, 0), 1) * 100)
    : null;
  const pages = typeof job.pagesDone === 'number' && typeof job.pagesTotal === 'number'
    ? desktopMessages().ocrPageProgress(job.pagesDone, job.pagesTotal)
    : null;
  return [stageLabel(job.stage ?? job.status), percent === null ? null : `${percent}%`, pages]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
}
