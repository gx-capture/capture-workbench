import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { filterHistoryRows, historyRow } from './history-list';

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
  it('formats pages, images, duration and unknown extent using queue rules', () => {
    expect(historyRow(document(), false).extent).toBe('3');
    expect(historyRow(document({ mediaType: 'image/png' }), false).extent).toBe('1');
    expect(historyRow(document({ mediaType: 'audio/mpeg', durationMs: 65_000 }), false).extent).toBe('1:05');
    expect(historyRow(document({ pageCount: undefined }), false).extent).toBe('—');
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
});
