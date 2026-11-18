import type { DesktopLibrarySummary } from '../contracts';
import { describeAsrDocument } from './asr-queue';
import type { CaptureUserStatus } from './capture-user-status';
import { describeOcrDocument } from './ocr-queue';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { isRecordingMediaType } from './desktop-workspace.selectors';

export interface HistoryRow {
  readonly documentId: string;
  readonly fileName: string;
  readonly kind: 'ocr' | 'asr';
  readonly userStatus: CaptureUserStatus;
  readonly statusText: string;
  readonly extent: string;
  readonly updatedAtMs: number;
  readonly updatedAt: string;
  readonly canDelete: boolean;
}

/** Formats an epoch timestamp as `YYYY/MM/DD HH:mm` in the user's local time zone. */
export function formatHistoryDate(milliseconds: number): string {
  const date = new Date(milliseconds);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

export interface HistoryFilters {
  readonly type: 'all' | 'ocr' | 'asr';
  readonly status: 'all' | CaptureUserStatus;
  readonly search: string;
}

export function historyRow(document: DesktopLibrarySummary, busy: boolean, operation?: DesktopCaptureOperation, active = false): HistoryRow {
  const kind = isRecordingMediaType(document.mediaType) ? 'asr' : 'ocr';
  const described = kind === 'asr'
    ? describeAsrDocument({ document, operation, busy: busy || active, speechReady: true, installPercent: null })
    : describeOcrDocument({ document, operation, busy: busy || active, ocrReady: true, installPercent: null });
  return {
    documentId: document.documentId,
    fileName: document.fileName,
    kind,
    userStatus: described.userStatus,
    statusText: described.statusText,
    extent: 'durationLabel' in described ? described.durationLabel : described.pageLabel,
    updatedAtMs: document.updatedAtMs,
    updatedAt: formatHistoryDate(document.updatedAtMs),
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
