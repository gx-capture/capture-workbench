import type { DesktopLibrarySummary } from '../contracts';
import { describeAsrDocument } from './asr-queue';
import type { CaptureRowInput, CaptureUserStatus } from './capture-user-status';
import { describeOcrDocument } from './ocr-queue';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { isRecordingMediaType } from './capture-media-types';

export interface HistoryRow {
  readonly documentId: string;
  readonly fileName: string;
  readonly kind: 'ocr' | 'asr';
  readonly userStatus: CaptureUserStatus;
  readonly statusText: string;
  /** Why this run could not start or end the document's capture, as its queue row says. */
  readonly failureReason: string | null;
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

/**
 * A History row, with the status and filter of the queues' rows. `claimed`:
 * this run is working on the document (a capture, a decision or a delete),
 * so it offers no Delete; every other row can be deleted, a linked one too.
 */
export function historyRow(
  document: DesktopLibrarySummary,
  run: Omit<CaptureRowInput, 'document'> & {
    readonly claimed: boolean;
    readonly operation?: DesktopCaptureOperation;
  },
): HistoryRow {
  const kind = isRecordingMediaType(document.mediaType) ? 'asr' : 'ocr';
  const input = { ...run, document, installPercent: null };
  const described = kind === 'asr'
    ? describeAsrDocument({ ...input, speechReady: true })
    : describeOcrDocument({ ...input, ocrReady: true });
  return {
    documentId: document.documentId,
    fileName: document.fileName,
    kind,
    userStatus: described.userStatus,
    statusText: described.statusText,
    failureReason: described.failureReason,
    extent: 'durationLabel' in described ? described.durationLabel : described.pageLabel,
    updatedAtMs: document.updatedAtMs,
    updatedAt: formatHistoryDate(document.updatedAtMs),
    canDelete: !run.owned && !run.claimed,
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
