import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { captureStatusChipClasses, captureStatusChipVariant } from './capture-user-status';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import {
  describeOcrDocument,
  groupRawOcrPages,
  parsePdfPageList,
  type OcrQueueView,
} from './ocr-queue';

describe('OCR queue presentation', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it.each(['image/png', 'image/jpeg'])('shows one page for %s', (mediaType) => {
    expect(view(doc({ mediaType, status: 'completed' })).pageLabel).toBe('1');
    expect(view(doc({ mediaType, pageCount: 12, captureOptions: { pdfPageCount: 3 } })).pageLabel).toBe('1');
  });

  it('shows a finished whole PDF page count from its summary', () => {
    expect(view(doc({ status: 'completed', pageCount: 12 })).pageLabel).toBe('12');
    expect(view(doc({ status: 'completed' })).pageLabel).toBe('—');
    expect(view(doc({ status: 'completed', pageCount: 12, captureOptions: { pdfPageCount: 3 } })).pageLabel).toBe('3');
  });

  // A row is shown from the stored document and "this run owns it" only.
  // Actions: Cancel, Start again, View (with exports on a finished row).
  it.each<[string, Partial<DesktopLibrarySummary>, RowRun, string, string, readonly string[]]>([
    ['waiting', { status: 'queued' }, {}, 'waiting', '等待中', ['cancel']],
    ['waiting, its start or cancel not stored in this run', { status: 'queued' }, { unstored: true },
      'needs-attention', '需要處理', ['start again']],
    ['started by this run', { status: 'queued' }, { owned: true }, 'processing', '處理中', ['cancel']],
    ['captured by this run', { status: 'processing', captureId: 'capture-1' }, { owned: true },
      'processing', '處理中', ['cancel']],
    ['being cancelled by this run', { status: 'processing', captureId: 'capture-1' }, { owned: true, cancelling: true },
      'processing', '取消中', ['cancel (applying)']],
    ['left processing by another run', { status: 'processing', captureId: 'capture-1' }, {},
      'needs-attention', '已中斷', ['start again']],
    ['left processing before its link was written', { status: 'processing' }, {},
      'needs-attention', '已中斷', ['start again']],
    ['left processing, also when this run could not store it', { status: 'processing' }, { unstored: true },
      'needs-attention', '已中斷', ['start again']],
    ['an earlier version’s persisting row', { status: 'persisting', captureId: 'capture-1' }, {},
      'needs-attention', '已中斷', ['start again']],
    ['waiting with a link', { status: 'queued', captureId: 'capture-1' }, {},
      'needs-attention', '已中斷', ['start again']],
    ['waiting with a raw result', { status: 'queued', hasRaw: true }, {},
      'needs-attention', '已中斷', ['view']],
    ['a checkpoint without raw text', { status: 'awaiting_confirmation' }, {},
      'needs-attention', '已中斷', ['start again']],
    ['a checkpoint with raw text', { status: 'awaiting_confirmation', hasRaw: true }, {}, 'done', '完成', ['view']],
    ['a checkpoint with raw text and a stale link', { status: 'awaiting_confirmation', hasRaw: true, captureId: 'capture-1' }, {},
      'done', '完成', ['view']],
    ['completed', { status: 'completed', hasRaw: true }, {}, 'done', '完成', ['view']],
    ['failed', { status: 'failed', errorMessage: 'broken' }, {}, 'needs-attention', '需要處理', ['start again']],
    ['failed with an earlier version’s raw result', { status: 'failed', hasRaw: true }, {},
      'needs-attention', '需要處理', ['view']],
    ['an earlier version’s recovery failure', { status: 'failed', recoveryCode: 'capture_recovery_required' }, {},
      'needs-attention', '已中斷', ['start again']],
    ['cancelled', { status: 'canceled' }, {}, 'cancelled', '已取消', ['start again']],
    ['an earlier version’s recovery row', {
      status: 'recovery_required', captureId: 'capture-1', recoveryCode: 'capture_recovery_required',
    }, {}, 'needs-attention', '已中斷', ['start again']],
    ['an earlier version’s failed cleanup after a failure', {
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'failed', captureId: 'capture-1',
    }, {}, 'needs-attention', '需要處理', ['start again']],
    ['an earlier version’s failed cleanup after a cancel', {
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'cancelled',
    }, {}, 'cancelled', '已取消', ['start again']],
    ['an earlier version’s failed cleanup after the checkpoint', {
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'awaiting_structuring', hasRaw: true,
    }, {}, 'done', '完成', ['view']],
  ])('shows a row %s', (_case, stored, run, userStatus, statusText, actions) => {
    const described = view(doc(stored), { busy: run.owned, cancelling: run.cancelling, unstored: run.unstored });

    expect([described.userStatus, described.statusText, rowActions(described)]).toEqual([userStatus, statusText, actions]);
    expect(described.interrupted).toBe(statusText === '已中斷');
  });

  it.each<[string, Partial<DesktopLibrarySummary>, string]>([
    ['waiting, passed by after the read of its stored row failed', { status: 'queued' }, '需要處理'],
    ['left processing by this run’s failed result write', { status: 'processing', captureId: 'capture-1' }, '已中斷'],
  ])('shows why this run could not start or end a row %s', (_case, stored, statusText) => {
    const described = view(doc(stored), { unstored: true, failureReason: 'library unreadable' });

    expect([described.statusText, described.failureReason, rowActions(described)])
      .toEqual([statusText, 'library unreadable', ['start again']]);
    expect(view(doc(stored)).failureReason).toBeNull();
  });

  // The reason explains the marker: once the document shows a state of its
  // own (a write whose answer failed after the host committed it, a Start
  // again declined on a stale row), the reason no longer stands under it.
  it.each<[string, Partial<DesktopLibrarySummary>, boolean, string]>([
    ['done', { status: 'awaiting_confirmation', stage: 'awaiting_structuring', hasRaw: true }, true, '完成'],
    ['cancelled', { status: 'canceled', stage: 'cancelled' }, true, '已取消'],
    ['failed as stored', { status: 'failed', errorCode: 'capture_failed', errorMessage: 'stored' }, true, '需要處理'],
    ['waiting', { status: 'queued' }, false, '等待中'],
  ])('shows no reason of this run on a row shown %s', (_case, stored, unstored, statusText) => {
    const described = view(doc(stored), { unstored, failureReason: 'the disk is full' });

    expect([described.statusText, described.failureReason]).toEqual([statusText, null]);
  });

  it('maps library records onto the five user statuses', () => {
    expect(view(doc({ status: 'queued' })).userStatus).toBe('waiting');
    expect(view(doc({ status: 'queued' })).statusText).toBe('等待中');
    expect(view(doc({ status: 'queued' }), { ocrReady: false }).needsInstall).toBe(true);
    expect(view(doc({ status: 'queued' }), { ocrReady: true }).needsInstall).toBe(false);

    expect(view(doc({ status: 'processing', captureId: 'capture-1' }), { busy: true }).userStatus).toBe('processing');
    expect(view(doc({ status: 'processing', captureId: 'capture-1' })).userStatus).toBe('needs-attention');
    expect(view(doc({ status: 'processing' })).userStatus).toBe('needs-attention');
    expect(view(doc({ status: 'processing' })).interrupted).toBe(true);

    expect(view(doc({ status: 'completed' })).userStatus).toBe('done');
    expect(view(doc({ status: 'completed' })).statusText).toBe('完成');
    expect(view(doc({ status: 'completed', hasRaw: true })).canExport).toBe(true);
    expect(view(doc({ status: 'completed' })).canExport).toBe(false);
    expect(view(doc({ status: 'awaiting_confirmation', hasRaw: true })).userStatus).toBe('done');
    expect(view(doc({ status: 'awaiting_confirmation' })).userStatus).toBe('needs-attention');

    expect(view(doc({ status: 'failed' })).userStatus).toBe('needs-attention');
    expect(view(doc({ status: 'failed' })).statusText).toBe('需要處理');
    expect(view(doc({ status: 'failed' })).interrupted).toBe(false);
    // A link names a capture of an earlier run: the row is interrupted whether it still has one or not.
    expect(view(doc({
      status: 'recovery_required',
      captureId: 'capture-1',
      recoveryCode: 'capture_recovery_required',
    })).interrupted).toBe(true);
    expect(view(doc({
      status: 'recovery_required',
      captureId: 'capture-1',
      recoveryCode: 'runtime_cleanup_failed',
      stage: 'failed',
    })).interrupted).toBe(false);

    expect(view(doc({ status: 'canceled' })).userStatus).toBe('cancelled');
    expect(view(doc({ status: 'canceled' })).statusText).toBe('已取消');
  });

  it('shows page progress only as the processing step', () => {
    const described = view(doc({ status: 'processing', captureId: 'capture-1' }), {
      busy: true,
      operation: {
        protocolVersion: '2',
        captureId: 'capture-1',
        ingestionId: 'ingestion-1',
        kind: 'pdf',
        status: 'extracting',
        progress: 0.75,
        pagesDone: 9,
        pagesTotal: 12,
        partialRevision: 0,
        lastEventSequence: 0,
        createdAt: '2026-11-10T00:00:00Z',
        updatedAt: '2026-11-10T00:00:00Z',
      },
    });

    expect(described.userStatus).toBe('processing');
    expect(described.statusText).toBe('處理中');
    expect(described.progressText).toContain('第 9/12 頁');
    expect(described.progressText).toContain('75%');
    expect(described.progressText).not.toContain('處理中');
  });

  it('groups raw OCR pages by page and segment order, skipping blanks and keeping empty processed pages', () => {
    const raw = {
      sourceText: 'fallback',
      ocrPageScope: {
        sourcePageCount: 3,
        requestedPageNumbers: [1, 2, 3],
        processedPageNumbers: [1, 2, 3],
      },
      segments: [
        { order: 1, locator: { kind: 'page', page: 3 }, text: '第三頁乙' },
        { order: 0, locator: { kind: 'page', page: 3 }, text: '第三頁甲' },
        { order: 0, locator: { kind: 'page', page: 2 }, text: '   ' },
        { order: 0, locator: { kind: 'page', page: 1 }, text: '第一頁' },
      ],
    } as unknown as RawCapture;

    expect(groupRawOcrPages(raw)).toEqual([
      { page: 1, text: '第一頁' },
      { page: 2, text: '' },
      { page: 3, text: '第三頁甲\n第三頁乙' },
    ]);
    expect(groupRawOcrPages(null)).toEqual([]);
  });

  it('parses and formats PDF page selections', () => {
    expect(parsePdfPageList('')).toBeNull();
    expect(parsePdfPageList('   ')).toBeNull();
    expect(parsePdfPageList('3')).toEqual([3]);
    expect(parsePdfPageList('1-5, 8, 10-12')).toEqual([1, 2, 3, 4, 5, 8, 10, 11, 12]);
    expect(parsePdfPageList('8, 1-5')).toEqual([1, 2, 3, 4, 5, 8]);
    expect(parsePdfPageList(' １ – ３ ， ８ 、 １０ ～ １２ ， １３ — １４ ')).toEqual([
      1, 2, 3, 8, 10, 11, 12, 13, 14,
    ]);
    expect(parsePdfPageList('2~4')).toEqual([2, 3, 4]);
    expect(parsePdfPageList('10～12—14')).toBe('invalid');
    expect(parsePdfPageList('4294967295')).toEqual([4_294_967_295]);
    expect(parsePdfPageList('1-500')).toHaveLength(500);

    for (const invalid of [
      '0',
      '0-3',
      '5-1',
      '1-5, 3',
      '1-3, 3-5',
      '2, 2',
      '1-501',
      '1-300, 301-501',
      '1-1000000',
      '4294967296',
      'abc',
      '1-',
      '-5',
      '1-2-3',
      '1,',
      ',1',
      '1,,2',
    ]) {
      expect(parsePdfPageList(invalid)).toBe('invalid');
    }

  });

  it('shows the selected page count on waiting PDF rows when pdfPageNumbers is stored', () => {
    expect(view(doc({
      status: 'queued',
      captureOptions: { pdfPageNumbers: [3, 7, 8, 20] },
    })).pageLabel).toBe('4');
  });

  it('maps OCR user statuses to chip variants and classes', () => {
    expect(captureStatusChipVariant('processing')).toBe('running');
    expect(captureStatusChipVariant('waiting')).toBe('waiting');
    expect(captureStatusChipVariant('cancelled')).toBe('waiting');
    expect(captureStatusChipVariant('done')).toBe('done');
    expect(captureStatusChipVariant('needs-attention')).toBe('error');

    expect(captureStatusChipClasses('running')).toContain('bg-secondary');
    expect(captureStatusChipClasses('waiting')).toContain('border-border');
    expect(captureStatusChipClasses('done')).toContain('bg-muted');
    expect(captureStatusChipClasses('error')).toContain('text-destructive');
  });

  it('includes chipVariant and progressPercent in the described document', () => {
    const queuedDoc = view(doc({ status: 'queued' }));
    expect(queuedDoc.chipVariant).toBe('waiting');
    expect(queuedDoc.progressPercent).toBeNull();

    const runningDoc = view(doc({ status: 'processing', captureId: 'capture-1' }), {
      busy: true,
      operation: {
        protocolVersion: '2',
        captureId: 'capture-1',
        ingestionId: 'ingestion-1',
        kind: 'pdf',
        status: 'extracting',
        progress: 0.75,
        pagesDone: 9,
        pagesTotal: 12,
        partialRevision: 0,
        lastEventSequence: 0,
        createdAt: '2026-11-10T00:00:00Z',
        updatedAt: '2026-11-10T00:00:00Z',
      },
    });
    expect(runningDoc.chipVariant).toBe('running');
    expect(runningDoc.progressPercent).toBe(75);
  });
});

function doc(partial: Partial<DesktopLibrarySummary>): DesktopLibrarySummary {
  return {
    documentId: 'b'.repeat(32),
    fileName: 'charge.pdf',
    mediaType: 'application/pdf',
    byteLength: 12,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: 'queued',
    ...partial,
  };
}

interface RowRun {
  readonly owned?: boolean;
  readonly cancelling?: boolean;
  readonly unstored?: boolean;
}

function rowActions(row: OcrQueueView): readonly string[] {
  return [
    ...(row.canCancel ? [row.cancelling ? 'cancel (applying)' : 'cancel'] : []),
    ...(row.canStartAgain ? ['start again'] : []),
    ...(row.canView ? ['view'] : []),
  ];
}

function view(
  document: DesktopLibrarySummary,
  extra: {
    readonly ocrReady?: boolean;
    readonly busy?: boolean;
    readonly cancelling?: boolean;
    readonly unstored?: boolean;
    readonly failureReason?: string;
    readonly operation?: DesktopCaptureOperation;
    readonly installPercent?: number | null;
  } = {},
) {
  return describeOcrDocument({
    document,
    ocrReady: extra.ocrReady ?? true,
    owned: extra.busy ?? false,
    cancelling: extra.cancelling,
    unstored: extra.unstored,
    failureReason: extra.failureReason,
    operation: extra.operation,
    installPercent: extra.installPercent ?? null,
  });
}
