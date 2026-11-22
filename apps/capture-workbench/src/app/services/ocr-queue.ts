import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { captureStatusChipVariant, type CaptureStatusChipVariant, type CaptureUserStatus } from './capture-user-status';
import { isActiveOneShotOperation, isCaptureLost, stageLabel } from './capture-operation-status';

export interface OcrQueueView {
  readonly documentId: string;
  readonly fileName: string;
  readonly pageLabel: string;
  readonly userStatus: CaptureUserStatus;
  readonly statusText: string;
  readonly progressText: string;
  readonly progressPercent: number | null;
  readonly chipVariant: CaptureStatusChipVariant;
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

export function ocrStatusText(status: CaptureUserStatus): string {
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
  readonly operation?: DesktopCaptureOperation;
  readonly busy: boolean;
  readonly ocrReady: boolean;
  readonly installPercent: number | null;
}): OcrQueueView {
  const { document } = input;
  const operationActive = input.operation !== undefined && isActiveOneShotOperation(input.operation);
  const described = describeStatus(document, input.busy || operationActive);
  const waiting = described.userStatus === 'waiting';
  const percent = typeof input.operation?.progress === 'number' && Number.isFinite(input.operation.progress)
    ? Math.round(Math.min(Math.max(input.operation.progress, 0), 1) * 100)
    : null;
  return {
    documentId: document.documentId,
    fileName: document.fileName,
    pageLabel: pageLabel(document, input.operation),
    userStatus: described.userStatus,
    statusText: ocrStatusText(described.userStatus),
    progressText: described.userStatus === 'processing'
      ? progressText(input.operation)
      : '',
    progressPercent: described.userStatus === 'processing' ? percent : null,
    chipVariant: captureStatusChipVariant(described.userStatus),
    needsInstall: waiting && !input.ocrReady,
    installPercent: waiting && !input.ocrReady ? input.installPercent : null,
    interrupted: described.interrupted,
    canExport: described.userStatus === 'done' && document.hasRaw === true,
  };
}

function describeStatus(
  document: DesktopLibrarySummary,
  active: boolean,
): { readonly userStatus: CaptureUserStatus; readonly interrupted: boolean } {
  if (active) return { userStatus: 'processing', interrupted: false };
  if (
    (document.status === 'processing' || document.status === 'persisting')
    && document.captureId
  ) {
    return { userStatus: 'processing', interrupted: false };
  }
  if (isCaptureLost(document)) {
    return { userStatus: 'needs-attention', interrupted: true };
  }
  if (document.status === 'canceled') {
    return { userStatus: 'cancelled', interrupted: false };
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
  operation: DesktopCaptureOperation | undefined,
): string {
  if (document.mediaType === 'image/png' || document.mediaType === 'image/jpeg') {
    return '1';
  }
  if (typeof operation?.pagesTotal === 'number') return String(operation.pagesTotal);
  const selectedPages = document.captureOptions?.pdfPageNumbers;
  if (Array.isArray(selectedPages) && selectedPages.length >= 1) {
    return String(selectedPages.length);
  }
  const chosen = document.captureOptions?.pdfPageCount;
  if (typeof chosen === 'number' && chosen >= 1) return String(chosen);
  if (typeof document.pageCount === 'number') return String(document.pageCount);
  return '—';
}

function progressText(operation: DesktopCaptureOperation | undefined): string {
  if (!operation) return '';
  const percent = typeof operation.progress === 'number' && Number.isFinite(operation.progress)
    ? Math.round(Math.min(Math.max(operation.progress, 0), 1) * 100)
    : null;
  const pages = typeof operation.pagesDone === 'number' && typeof operation.pagesTotal === 'number'
    ? desktopMessages().ocrPageProgress(operation.pagesDone, operation.pagesTotal)
    : null;
  return [stageLabel(operation.status), percent === null ? null : `${percent}%`, pages]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
}
