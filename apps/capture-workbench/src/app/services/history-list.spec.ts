import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { filterHistoryRows, formatHistoryDate, historyRow } from './history-list';
import { describeAsrDocument } from './asr-queue';
import { describeOcrDocument } from './ocr-queue';

const document = (overrides: Partial<DesktopLibrarySummary> = {}): DesktopLibrarySummary => ({
  documentId: 'a', fileName: 'Report.pdf', mediaType: 'application/pdf', byteLength: 1,
  createdAtMs: 1, updatedAtMs: 2, status: 'completed', pageCount: 3, ...overrides,
});
const free = { owned: false, claimed: false } as const;
const owned = { owned: true, claimed: true } as const;

describe('history list', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));
  it.each(['application/pdf', 'audio/mpeg'])('maps the five statuses for %s', (mediaType) => {
    for (const [status, expected] of [
      ['queued', 'waiting'], ['processing', 'needs-attention'], ['completed', 'done'],
      ['failed', 'needs-attention'], ['canceled', 'cancelled'],
    ] as const) {
      expect(historyRow(document({ mediaType, status }), free).userStatus).toBe(expected);
    }
    expect(historyRow(document({ mediaType }), owned).userStatus).toBe('processing');
    // A link another run left is never followed: the row is interrupted.
    expect(historyRow(document({ mediaType, status: 'processing', captureId: 'capture' }), free).statusText).toBe('已中斷');
  });
  it.each(['application/pdf', 'audio/mpeg'])('shows why this run could not start or end a %s row, as its queue does', (mediaType) => {
    const run = { owned: false, claimed: false, unstored: true, failureReason: 'the disk is full' };
    expect(historyRow(document({ mediaType, status: 'processing', captureId: 'capture' }), run))
      .toMatchObject({ statusText: '已中斷', failureReason: 'the disk is full' });
    expect(historyRow(document({ mediaType, status: 'queued' }), run))
      .toMatchObject({ statusText: '需要處理', failureReason: 'the disk is full' });
    expect(historyRow(document({ mediaType, status: 'failed', errorMessage: 'stored' }), free).failureReason).toBeNull();
    // A row that shows a state of its own does not keep this run's reason.
    for (const stored of [{ status: 'completed', hasRaw: true }, { status: 'canceled' }, { status: 'failed' }] as const) {
      expect(historyRow(document({ mediaType, ...stored }), run).failureReason).toBeNull();
    }
  });
  it('keeps OCR raw text complete and an unfinished recording needing attention', () => {
    expect(historyRow(document({ status: 'awaiting_confirmation', hasRaw: true }), free).userStatus).toBe('done');
    expect(historyRow(document({ mediaType: 'audio/mpeg', status: 'awaiting_confirmation', hasRaw: true }), free).userStatus).toBe('needs-attention');
  });
  it.each(['application/pdf', 'audio/mpeg'])('shows the queue’s status for %s', (mediaType) => {
    const queueView = (item: DesktopLibrarySummary, run: { readonly owned: boolean; readonly cancelling?: boolean; readonly unstored?: boolean }) =>
      mediaType === 'audio/mpeg'
        ? describeAsrDocument({ document: item, ...run, speechReady: true, installPercent: null })
        : describeOcrDocument({ document: item, ...run, ocrReady: true, installPercent: null });
    const cases: readonly [Partial<DesktopLibrarySummary>, { readonly owned: boolean; readonly cancelling?: boolean; readonly unstored?: boolean }, string][] = [
      [{ status: 'processing' }, { owned: false }, 'needs-attention'],
      [{ status: 'persisting', captureId: 'capture' }, { owned: false }, 'needs-attention'],
      [{ status: 'processing', captureId: 'capture' }, { owned: true }, 'processing'],
      [{ status: 'processing', captureId: 'capture' }, { owned: true, cancelling: true }, 'processing'],
      [{ status: 'queued' }, { owned: false, unstored: true }, 'needs-attention'],
      [{ status: 'recovery_required', recoveryCode: 'capture_recovery_required' }, { owned: false }, 'needs-attention'],
      [{ status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'cancelled' }, { owned: false }, 'cancelled'],
      [{ status: 'awaiting_confirmation', hasRaw: false }, { owned: false }, 'needs-attention'],
    ];
    for (const [overrides, run, expected] of cases) {
      const item = document({ mediaType, ...overrides });
      const row = historyRow(item, { ...run, claimed: run.owned });
      expect(row.userStatus).toBe(expected);
      expect(row.statusText).toBe(queueView(item, run).statusText);
    }
  });
  it.each(['processing', 'done', 'needs-attention', 'cancelled'] as const)('filters the %s user status', (status) => {
    const rows = [
      historyRow(document({ documentId: 'processing' }), owned),
      historyRow(document({ documentId: 'done' }), free),
      historyRow(document({ documentId: 'needs-attention', status: 'failed' }), free),
      historyRow(document({ documentId: 'cancelled', status: 'canceled' }), free),
    ];
    expect(filterHistoryRows(rows, { type: 'all', status, search: '' }).map((row) => row.documentId)).toEqual([status]);
  });
  it('formats pages, images, duration and unknown extent using queue rules', () => {
    expect(historyRow(document(), free).extent).toBe('3');
    expect(historyRow(document({ mediaType: 'image/png' }), free).extent).toBe('1');
    expect(historyRow(document({ mediaType: 'audio/mpeg', durationMs: 65_000 }), free).extent).toBe('1:05');
    expect(historyRow(document({ pageCount: undefined }), free).extent).toBe('—');
    expect(historyRow(document({ mediaType: 'audio/mpeg' }), free).extent).toBe('—');
  });
  it('filters each field and orders newest first without mutating the input', () => {
    const rows = [historyRow(document(), free), historyRow(document({ documentId: 'b', fileName: 'Meeting.mp3', mediaType: 'audio/mpeg', status: 'queued', updatedAtMs: 3 }), free)];
    const all = { type: 'all', status: 'all', search: '' } as const;
    expect(filterHistoryRows(rows, all).map((row) => row.documentId)).toEqual(['b', 'a']);
    expect(filterHistoryRows(rows, { ...all, type: 'asr' })).toEqual([rows[1]]);
    expect(filterHistoryRows(rows, { ...all, type: 'ocr' })).toEqual([rows[0]]);
    expect(filterHistoryRows(rows, { ...all, status: 'waiting' })).toEqual([rows[1]]);
    expect(filterHistoryRows(rows, { ...all, search: ' REPORT ' })).toEqual([rows[0]]);
    expect(filterHistoryRows(rows, { ...all, type: 'asr', search: 'report' })).toEqual([]);
    expect(rows[0]?.documentId).toBe('a');
  });
  it.each<[string, Partial<DesktopLibrarySummary>]>([
    ['a finished row', {}],
    ['a row another run left processing, link and all', { status: 'processing', captureId: 'capture' }],
    ['a waiting row with a link', { status: 'queued', captureId: 'capture' }],
    ['an earlier version’s recovery row', { status: 'recovery_required', captureId: 'capture', recoveryCode: 'capture_recovery_required' }],
    ['a failed row', { status: 'failed' }],
  ])('offers Delete for %s this run is not working on, and none while it is', (_case, stored) => {
    expect(historyRow(document(stored), free).canDelete).toBe(true);
    expect(historyRow(document(stored), owned).canDelete).toBe(false);
    // A decision or a delete claims the document without capturing it.
    expect(historyRow(document(stored), { owned: false, claimed: true }).canDelete).toBe(false);
  });
  it('keeps the stored status of a row being deleted and offers no second delete', () => {
    const stored = historyRow(document(), free);
    expect(historyRow(document(), { owned: false, claimed: true })).toEqual({ ...stored, canDelete: false });
  });
  it('formats updatedAt as YYYY/MM/DD HH:mm in local 24-hour time regardless of locale', () => {
    const timestamp = new Date(2026, 10, 16, 14, 5).getTime();
    expect(formatHistoryDate(timestamp)).toBe('2026/11/16 14:05');
    expect(historyRow(document({ updatedAtMs: timestamp }), free).updatedAt).toBe('2026/11/16 14:05');
    setDesktopLocale('en');
    expect(historyRow(document({ updatedAtMs: timestamp }), free).updatedAt).toBe('2026/11/16 14:05');
  });
});
