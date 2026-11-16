import type { DesktopLibrarySummary } from '../contracts';
import { describeAsrDocument } from './asr-queue';
import { describeOcrDocument, ocrStatusText, type OcrUserStatus } from './ocr-queue';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { isAudioMediaType } from './desktop-workspace.selectors';

export interface HistoryRow {
  readonly documentId: string;
  readonly fileName: string;
  readonly kind: 'ocr' | 'asr';
  readonly userStatus: OcrUserStatus;
  readonly statusText: string;
  readonly extent: string;
  readonly updatedAtMs: number;
  readonly canDelete: boolean;
}

export interface HistoryFilters {
  readonly type: 'all' | 'ocr' | 'asr';
  readonly status: 'all' | OcrUserStatus;
  readonly search: string;
}

export function historyRow(document: DesktopLibrarySummary, busy: boolean, job?: DesktopCaptureOperation, active = false): HistoryRow {
  const kind = isAudioMediaType(document.mediaType) ? 'asr' : 'ocr';
  const described = kind === 'asr'
    ? describeAsrDocument({ document, operation: job, busy: busy || active, speechReady: true, installPercent: null })
    : describeOcrDocument({ document, job, busy: busy || active, ocrReady: true, installPercent: null });
  return {
    documentId: document.documentId,
    fileName: document.fileName,
    kind,
    userStatus: described.userStatus,
    statusText: ocrStatusText(described.userStatus),
    extent: 'durationLabel' in described ? described.durationLabel : described.pageLabel,
    updatedAtMs: document.updatedAtMs,
    canDelete: !busy && !active && !document.captureId,
  };
}

export function filterHistoryRows(rows: readonly HistoryRow[], filters: HistoryFilters): HistoryRow[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return rows.filter((row) =>
    (filters.type === 'all' || row.kind === filters.type)
    && (filters.status === 'all' || row.userStatus === filters.status)
    && row.fileName.toLocaleLowerCase().includes(search),
  ).sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}
