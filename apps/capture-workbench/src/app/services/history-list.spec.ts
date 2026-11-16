import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { filterHistoryRows, formatHistoryDate, historyRow } from './history-list';
import { describeAsrDocument } from './asr-queue';
import { describeOcrDocument } from './ocr-queue';

const document = (overrides: Partial<DesktopLibrarySummary> = {}): DesktopLibrarySummary => ({
  documentId: 'a', fileName: 'Report.pdf', mediaType: 'application/pdf', byteLength: 1,
  createdAtMs: 1, updatedAtMs: 2, status: 'completed', pageCount: 3, ...overrides,
});

describe('history list', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));
  it.each(['application/pdf', 'audio/mpeg'])('maps the five statuses for %s', (mediaType) => {
    for (const [status, expected] of [
      ['queued', 'waiting'], ['processing', 'needs-attention'], ['completed', 'done'],
      ['failed', 'needs-attention'], ['canceled', 'cancelled'],
    ] as const) {
      expect(historyRow(document({ mediaType, status }), false).userStatus).toBe(expected);
    }
    expect(historyRow(document({ mediaType }), true).userStatus).toBe('processing');
    expect(historyRow(document({ mediaType, status: 'processing', captureId: 'capture' }), false).userStatus).toBe('processing');
  });
  it('keeps OCR raw text complete and an unfinished recording needing attention', () => {
    expect(historyRow(document({ status: 'awaiting_confirmation', hasRaw: true }), false).userStatus).toBe('done');
    expect(historyRow(document({ mediaType: 'audio/mpeg', status: 'awaiting_confirmation', hasRaw: true }), false).userStatus).toBe('needs-attention');
  });
  it.each(['application/pdf', 'audio/mpeg'])('preserves queue status text and recovery rules for %s', (mediaType) => {
    const queueView = (item: DesktopLibrarySummary) => mediaType === 'audio/mpeg'
      ? describeAsrDocument({ document: item, busy: false, speechReady: true, installPercent: null })
      : describeOcrDocument({ document: item, busy: false, ocrReady: true, installPercent: null });
    const cases: readonly [Partial<DesktopLibrarySummary>, string][] = [
      [{ status: 'processing' }, 'needs-attention'],
      [{ status: 'persisting' }, 'needs-attention'],
      [{ status: 'persisting', captureId: 'capture' }, 'processing'],
      [{ status: 'recovery_required' }, 'needs-attention'],
      [{ status: 'recovery_required', recoveryCode: 'capture_recovery_required' }, 'needs-attention'],
      [{ status: 'awaiting_confirmation', hasRaw: false }, 'needs-attention'],
    ];
    for (const [overrides, expected] of cases) {
      const item = document({ mediaType, ...overrides });
      const row = historyRow(item, false);
      expect(row.userStatus).toBe(expected);
      expect(row.statusText).toBe(queueView(item).statusText);
    }
  });
  it.each(['processing', 'done', 'needs-attention', 'cancelled'] as const)('filters the %s user status', (status) => {
    const rows = [
      historyRow(document({ documentId: 'processing' }), true),
      historyRow(document({ documentId: 'done' }), false),
      historyRow(document({ documentId: 'needs-attention', status: 'failed' }), false),
      historyRow(document({ documentId: 'cancelled', status: 'canceled' }), false),
    ];
    expect(filterHistoryRows(rows, { type: 'all', status, search: '' }).map((row) => row.documentId)).toEqual([status]);
  });
  it('formats pages, images, duration and unknown extent using queue rules', () => {
    expect(historyRow(document(), false).extent).toBe('3');
    expect(historyRow(document({ mediaType: 'image/png' }), false).extent).toBe('1');
    expect(historyRow(document({ mediaType: 'audio/mpeg', durationMs: 65_000 }), false).extent).toBe('1:05');
    expect(historyRow(document({ pageCount: undefined }), false).extent).toBe('—');
    expect(historyRow(document({ mediaType: 'audio/mpeg' }), false).extent).toBe('—');
  });
  it('filters each field and orders newest first without mutating the input', () => {
    const rows = [historyRow(document(), false), historyRow(document({ documentId: 'b', fileName: 'Meeting.mp3', mediaType: 'audio/mpeg', status: 'queued', updatedAtMs: 3 }), false)];
    const all = { type: 'all', status: 'all', search: '' } as const;
    expect(filterHistoryRows(rows, all).map((row) => row.documentId)).toEqual(['b', 'a']);
    expect(filterHistoryRows(rows, { ...all, type: 'asr' })).toEqual([rows[1]]);
    expect(filterHistoryRows(rows, { ...all, type: 'ocr' })).toEqual([rows[0]]);
    expect(filterHistoryRows(rows, { ...all, status: 'waiting' })).toEqual([rows[1]]);
    expect(filterHistoryRows(rows, { ...all, search: ' REPORT ' })).toEqual([rows[0]]);
    expect(filterHistoryRows(rows, { ...all, type: 'asr', search: 'report' })).toEqual([]);
    expect(rows[0]?.documentId).toBe('a');
  });
  it('disallows deletion while busy, active or recoverable', () => {
    expect(historyRow(document(), false).canDelete).toBe(true);
    expect(historyRow(document(), true).canDelete).toBe(false);
    expect(historyRow(document(), false, undefined, true).canDelete).toBe(false);
    expect(historyRow(document({ captureId: 'capture' }), false).canDelete).toBe(false);
  });
  it('formats updatedAt as YYYY/MM/DD HH:mm in local 24-hour time regardless of locale', () => {
    const timestamp = new Date(2026, 10, 16, 14, 5).getTime();
    expect(formatHistoryDate(timestamp)).toBe('2026/11/16 14:05');
    expect(historyRow(document({ updatedAtMs: timestamp }), false).updatedAt).toBe('2026/11/16 14:05');
    setDesktopLocale('en');
    expect(historyRow(document({ updatedAtMs: timestamp }), false).updatedAt).toBe('2026/11/16 14:05');
  });
});
