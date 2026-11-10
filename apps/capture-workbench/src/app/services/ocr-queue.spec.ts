import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import {
  describeOcrDocument,
  parsePdfPageCount,
  pdfPagePrefix,
  refuseOcrFile,
  renderRawOcrText,
} from './ocr-queue';

describe('OCR queue presentation', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

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
        status: 'running',
        stage: 'extracting',
        progress: 0.75,
        pagesDone: 9,
        pagesTotal: 12,
      } as DesktopCaptureOperation,
    });

    expect(described.userStatus).toBe('processing');
    expect(described.statusText).toBe('處理中');
    expect(described.progressText).toContain('第 9/12 頁');
    expect(described.progressText).toContain('75%');
    expect(described.progressText).not.toContain('處理中');
  });

  it('renders raw OCR text in page order, with a blank line between pages', () => {
    const raw = {
      sourceText: 'fallback',
      segments: [
        { order: 1, locator: { kind: 'page', page: 1 }, text: '第一頁乙' },
        { order: 0, locator: { kind: 'page', page: 2 }, text: '第二頁' },
        { order: 0, locator: { kind: 'page', page: 1 }, text: '第一頁甲' },
        { order: 2, locator: { kind: 'page', page: 1 }, text: '   ' },
        { order: 0, locator: { kind: 'time', startMs: 0, endMs: 1 }, text: '忽略' },
      ],
    } as unknown as RawCapture;

    expect(renderRawOcrText(raw)).toBe('第一頁甲\n第一頁乙\n\n第二頁');
    expect(renderRawOcrText({ ...raw, segments: [] } as RawCapture)).toBe('fallback');
  });

  it('refuses an unsupported file by name and keeps a 1..K page prefix', () => {
    expect(refuseOcrFile('notes.txt')).toContain('notes.txt');
    expect(refuseOcrFile('charge.pdf')).toBeNull();
    expect(refuseOcrFile('scan.PNG')).toBeNull();
    expect(parsePdfPageCount('')).toBeNull();
    expect(parsePdfPageCount('3')).toBe(3);
    expect(parsePdfPageCount('0')).toBe('invalid');
    expect(pdfPagePrefix(3)).toEqual([1, 2, 3]);
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
