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

export type OcrChipVariant = 'running' | 'waiting' | 'done' | 'error';

/** Maps an OCR user status to its chip styling variant. */
export function ocrChipVariant(status: OcrUserStatus): OcrChipVariant {
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
export function ocrChipClasses(variant: OcrChipVariant): string {
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

export interface OcrQueueView {
  readonly documentId: string;
  readonly fileName: string;
  readonly pageLabel: string;
  readonly userStatus: OcrUserStatus;
  readonly statusText: string;
  readonly progressText: string;
  readonly progressPercent: number | null;
  readonly chipVariant: OcrChipVariant;
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

const MAX_PDF_PAGE_SELECTION = 500;
const MAX_PDF_PAGE_NUMBER = 4_294_967_295;

export function isOcrMediaType(mediaType: string): boolean {
  return mediaType === 'application/pdf'
    || mediaType === 'image/png'
    || mediaType === 'image/jpeg';
}

/**
 * Parses a PDF page selection such as `1-5, 8, 10-12`.
 * Blank means every page (`null`); invalid syntax, `0`, reversed ranges,
 * duplicates/overlaps, > 500 pages, or pages > 4294967295 return `'invalid'`.
 */
export function parsePdfPageList(value: string): readonly number[] | null | 'invalid' {
  const normalized = normalizePageText(value);
  if (normalized === '') return null;
  const tokens = normalized.split(/[,，、]/u);
  const selected = new Set<number>();
  for (const token of tokens) {
    if (token === '') return 'invalid';
    const parts = token.split(/[-–—~～]/u);
    if (parts.length === 1) {
      const page = parsePositivePageNumber(parts[0]);
      if (page === null || selected.has(page) || selected.size >= MAX_PDF_PAGE_SELECTION) {
        return 'invalid';
      }
      selected.add(page);
    } else if (parts.length === 2) {
      const start = parsePositivePageNumber(parts[0]);
      const end = parsePositivePageNumber(parts[1]);
      if (start === null || end === null || start > end) return 'invalid';
      const rangeLength = end - start + 1;
      if (rangeLength > MAX_PDF_PAGE_SELECTION - selected.size) return 'invalid';
      for (let page = start; page <= end; page += 1) {
        if (selected.has(page)) return 'invalid';
        selected.add(page);
      }
    } else {
      return 'invalid';
    }
  }
  return [...selected].sort((left, right) => left - right);
}

/** Formats an ascending list of page numbers into compact range notation (e.g. `1-5, 8`). */
export function formatPdfPageList(pages: readonly number[]): string {
  if (pages.length === 0) return '';
  const sorted = [...pages].sort((left, right) => left - right);
  const parts: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    const page = sorted[index];
    if (page === end + 1) {
      end = page;
    } else {
      parts.push(start === end ? String(start) : `${start}-${end}`);
      start = page;
      end = page;
    }
  }
  parts.push(start === end ? String(start) : `${start}-${end}`);
  return parts.join(', ');
}

function normalizePageText(value: string): string {
  return value
    .replace(/\s+/gu, '')
    .replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

function parsePositivePageNumber(token: string): number | null {
  if (!/^\d+$/u.test(token)) return null;
  const page = Number(token);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PDF_PAGE_NUMBER) {
    return null;
  }
  return page;
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

export interface OcrPageText {
  readonly page: number;
  readonly text: string;
}

/** Groups raw OCR segments by page (including empty processed pages), ordered by page then segment order. */
export function groupRawOcrPages(
  raw: RawCapture | null | undefined,
): readonly OcrPageText[] {
  if (!raw) return [];
  const pages = new Map<number, { readonly order: number; readonly text: string }[]>();
  for (const segment of raw.segments) {
    if (segment.locator.kind !== 'page') continue;
    if (segment.text.trim() === '') continue;
    const group = pages.get(segment.locator.page) ?? [];
    group.push({ order: segment.order, text: segment.text });
    pages.set(segment.locator.page, group);
  }
  for (const page of raw.ocrPageScope?.processedPageNumbers ?? []) {
    if (!pages.has(page)) {
      pages.set(page, []);
    }
  }
  return [...pages.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([page, segments]) => ({
      page,
      text: [...segments]
        .sort((left, right) => left.order - right.order)
        .map((segment) => segment.text)
        .join('\n'),
    }));
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
  const percent = typeof input.job?.progress === 'number' && Number.isFinite(input.job.progress)
    ? Math.round(Math.min(Math.max(input.job.progress, 0), 1) * 100)
    : null;
  return {
    documentId: document.documentId,
    fileName: document.fileName,
    pageLabel: pageLabel(document, input.job),
    userStatus: described.userStatus,
    statusText: ocrStatusText(described.userStatus),
    progressText: described.userStatus === 'processing'
      ? progressText(input.job)
      : '',
    progressPercent: described.userStatus === 'processing' ? percent : null,
    chipVariant: ocrChipVariant(described.userStatus),
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
  const selectedPages = document.captureOptions?.pdfPageNumbers;
  if (Array.isArray(selectedPages) && selectedPages.length >= 1) {
    return String(selectedPages.length);
  }
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
  return [stageLabel(job.status), percent === null ? null : `${percent}%`, pages]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
}
