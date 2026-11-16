import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import {
  describeOcrDocument,
  groupRawOcrPages,
  ocrChipClasses,
  ocrChipVariant,
  parsePdfPageList,
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

  it('maps library records onto the five user statuses', () => {
    expect(view(doc({ status: 'queued' })).userStatus).toBe('waiting');
    expect(view(doc({ status: 'queued' })).statusText).toBe('等待中');
    expect(view(doc({ status: 'queued' }), { ocrReady: false }).needsInstall).toBe(true);
    expect(view(doc({ status: 'queued' }), { ocrReady: true }).needsInstall).toBe(false);

    expect(view(doc({ status: 'processing', captureId: 'capture-1' })).userStatus).toBe('processing');
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
    expect(view(doc({
      status: 'recovery_required',
      captureId: 'capture-1',
      recoveryCode: 'capture_recovery_required',
    })).interrupted).toBe(true);
    expect(view(doc({
      status: 'recovery_required',
      captureId: 'capture-1',
      recoveryCode: 'runtime_cleanup_failed',
    })).interrupted).toBe(false);

    expect(view(doc({ status: 'canceled' })).userStatus).toBe('cancelled');
    expect(view(doc({ status: 'canceled' })).statusText).toBe('已取消');
  });

  it('shows page progress only as the processing step', () => {
    const described = view(doc({ status: 'processing', captureId: 'capture-1' }), {
      job: {
        protocolVersion: '2',
        captureId: 'capture-1',
        ingestionId: 'ingestion-1',
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
    expect(ocrChipVariant('processing')).toBe('running');
    expect(ocrChipVariant('waiting')).toBe('waiting');
    expect(ocrChipVariant('cancelled')).toBe('waiting');
    expect(ocrChipVariant('done')).toBe('done');
    expect(ocrChipVariant('needs-attention')).toBe('error');

    expect(ocrChipClasses('running')).toContain('bg-secondary');
    expect(ocrChipClasses('waiting')).toContain('border-border');
    expect(ocrChipClasses('done')).toContain('bg-muted');
    expect(ocrChipClasses('error')).toContain('text-destructive');
  });

  it('includes chipVariant and progressPercent in the described document', () => {
    const queuedDoc = view(doc({ status: 'queued' }));
    expect(queuedDoc.chipVariant).toBe('waiting');
    expect(queuedDoc.progressPercent).toBeNull();

    const runningDoc = view(doc({ status: 'processing', captureId: 'capture-1' }), {
      job: {
        protocolVersion: '2',
        captureId: 'capture-1',
        ingestionId: 'ingestion-1',
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

function view(
  document: DesktopLibrarySummary,
  extra: {
    readonly ocrReady?: boolean;
    readonly busy?: boolean;
    readonly job?: DesktopCaptureOperation;
    readonly installPercent?: number | null;
  } = {},
) {
  return describeOcrDocument({
    document,
    ocrReady: extra.ocrReady ?? true,
    busy: extra.busy ?? false,
    job: extra.job,
    installPercent: extra.installPercent ?? null,
  });
}
