import { TestBed } from '@angular/core/testing';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { firstValueFrom, lastValueFrom, of, throwError } from 'rxjs';
import {
  computePdfRenderScale,
  isPdfPageInBounds,
  MAX_PDF_CANVAS_PIXELS,
  MAX_PDF_DEVICE_PIXEL_RATIO,
  PDF_JS_LOADER,
  PdfPageRenderer,
  type PdfJsApi,
} from './pdf-page-renderer.service';

describe('computePdfRenderScale', () => {
  it('scales to fit targetCssWidth at 1x DPR', () => {
    const dims = computePdfRenderScale({
      pageWidth: 200,
      pageHeight: 400,
      targetCssWidth: 600,
      devicePixelRatio: 1,
    });

    expect(dims.scale).toBe(3);
    expect(dims.cssWidth).toBe(600);
    expect(dims.cssHeight).toBe(1200);
    expect(dims.pixelWidth).toBe(600);
    expect(dims.pixelHeight).toBe(1200);
  });

  it('caps devicePixelRatio at MAX_PDF_DEVICE_PIXEL_RATIO (2)', () => {
    const dims = computePdfRenderScale({
      pageWidth: 200,
      pageHeight: 300,
      targetCssWidth: 400,
      devicePixelRatio: 4,
    });

    expect(MAX_PDF_DEVICE_PIXEL_RATIO).toBe(2);
    expect(dims.scale).toBe(4);
    expect(dims.pixelWidth).toBe(800);
    expect(dims.pixelHeight).toBe(1200);
  });

  it('caps canvas pixel count at maxCanvasPixels while preserving aspect ratio', () => {
    const dims = computePdfRenderScale({
      pageWidth: 1000,
      pageHeight: 2000,
      targetCssWidth: 4000,
      devicePixelRatio: 2,
      maxCanvasPixels: 16_000_000,
    });

    expect(MAX_PDF_CANVAS_PIXELS).toBe(16_000_000);
    expect(dims.pixelWidth * dims.pixelHeight).toBeLessThanOrEqual(16_000_000);
    expect(dims.pixelWidth).toBeGreaterThan(0);
    expect(dims.pixelHeight).toBeGreaterThan(0);
    expect(dims.pixelHeight / dims.pixelWidth).toBeCloseTo(2, 1);
  });

  it('falls back to pageWidth when targetCssWidth is zero', () => {
    const dims = computePdfRenderScale({
      pageWidth: 500,
      pageHeight: 700,
      targetCssWidth: 0,
      devicePixelRatio: 1,
    });

    expect(dims.scale).toBe(1);
    expect(dims.pixelWidth).toBe(500);
    expect(dims.pixelHeight).toBe(700);
  });
});

describe('isPdfPageInBounds', () => {
  it('checks integer 1..pageCount bounds', () => {
    expect(isPdfPageInBounds(1, 3)).toBe(true);
    expect(isPdfPageInBounds(3, 3)).toBe(true);
    expect(isPdfPageInBounds(0, 3)).toBe(false);
    expect(isPdfPageInBounds(4, 3)).toBe(false);
    expect(isPdfPageInBounds(1.5, 3)).toBe(false);
    expect(isPdfPageInBounds(1, 0)).toBe(false);
  });
});

describe('PdfPageRenderer', () => {
  function setupFakePdfJs(options: {
    readonly loader?: ReturnType<typeof vi.fn>;
    readonly docPromise?: Promise<unknown>;
  } = {}) {
    const workerOptions = { workerSrc: '' };
    const loadingTaskDestroy = vi.fn().mockResolvedValue(undefined);
    const renderMock = vi.fn();
    const getViewportMock = vi.fn(({ scale }: { scale: number }) => ({
      width: 200 * scale,
      height: 300 * scale,
      scale,
    }));
    const getPageMock = vi.fn().mockResolvedValue({
      getViewport: getViewportMock,
      render: renderMock,
    });
    const fakeDoc = {
      numPages: 2,
      getPage: getPageMock,
    };
    const fakeLoadingTask = {
      promise: options.docPromise ?? Promise.resolve(fakeDoc),
      destroy: loadingTaskDestroy,
    } as unknown as PDFDocumentLoadingTask;
    const getDocumentMock = vi.fn((_params: Record<string, unknown>) => fakeLoadingTask);

    const fakeApi: PdfJsApi = {
      GlobalWorkerOptions: workerOptions,
      getDocument: getDocumentMock as unknown as PdfJsApi['getDocument'],
    };

    const loader = options.loader ?? vi.fn(() => of(fakeApi));

    TestBed.configureTestingModule({
      providers: [
        PdfPageRenderer,
        { provide: PDF_JS_LOADER, useValue: loader },
      ],
    });

    const renderer = TestBed.inject(PdfPageRenderer);
    return {
      renderer,
      fakeApi,
      loader,
      workerOptions,
      getDocumentMock,
      getPageMock,
      getViewportMock,
      renderMock,
      loadingTaskDestroy,
    };
  }

  it('opens a PDF with CSP-safe options, copied bytes, and exposes pageCount', async () => {
    const { renderer, workerOptions, getDocumentMock } = setupFakePdfJs();
    const source = new Uint8Array([1, 2, 3, 4]).buffer;

    const handle = await firstValueFrom(renderer.open(source));

    expect(handle.pageCount).toBe(2);
    expect(workerOptions.workerSrc).toContain('/assets/pdfjs/pdf.worker.min.mjs');
    expect(getDocumentMock).toHaveBeenCalledTimes(1);

    const initParams = getDocumentMock.mock.calls[0][0];
    expect(initParams['useWasm']).toBe(false);
    expect(initParams['cMapPacked']).toBe(true);
    expect(String(initParams['wasmUrl'])).toContain('/assets/pdfjs/wasm/');
    expect(String(initParams['cMapUrl'])).toContain('/assets/pdfjs/cmaps/');
    expect(String(initParams['standardFontDataUrl'])).toContain(
      '/assets/pdfjs/standard_fonts/',
    );
    const passedData = initParams['data'] as Uint8Array;
    expect(passedData).toBeInstanceOf(Uint8Array);
    expect(passedData.buffer).not.toBe(source);
    expect([...passedData]).toEqual([1, 2, 3, 4]);
  });

  it('loads pdf.js once and retries after a failed load', async () => {
    const loaded: { api?: PdfJsApi } = {};
    const loader = vi
      .fn()
      .mockImplementationOnce(() => throwError(() => new Error('load failed')))
      .mockImplementation(() => of(loaded.api));
    const ctx = setupFakePdfJs({ loader });
    loaded.api = ctx.fakeApi;

    await expect(firstValueFrom(ctx.renderer.open(new ArrayBuffer(4)))).rejects.toThrow(
      'load failed',
    );
    await firstValueFrom(ctx.renderer.open(new ArrayBuffer(4)));
    await firstValueFrom(ctx.renderer.open(new ArrayBuffer(4)));

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('destroys the loading task if unsubscribed before open resolves', () => {
    const pendingDoc = new Promise<unknown>(() => undefined);
    const { renderer, loadingTaskDestroy } = setupFakePdfJs({ docPromise: pendingDoc });

    const sub = renderer.open(new ArrayBuffer(8)).subscribe();
    sub.unsubscribe();

    expect(loadingTaskDestroy).toHaveBeenCalledTimes(1);
  });

  it('renders a page with the computed viewport onto the canvas', async () => {
    const { renderer, getPageMock, renderMock } = setupFakePdfJs();
    renderMock.mockReturnValue({
      promise: Promise.resolve(undefined),
      cancel: vi.fn(),
    });

    const handle = await firstValueFrom(renderer.open(new ArrayBuffer(8)));
    const canvas = document.createElement('canvas');

    await lastValueFrom(
      handle.renderPage(2, canvas, { cssWidth: 400, devicePixelRatio: 2 }),
    );

    expect(getPageMock).toHaveBeenCalledWith(2);
    expect(renderMock).toHaveBeenCalledWith({
      canvas,
      viewport: expect.objectContaining({ scale: 4, width: 800, height: 1200 }),
    });
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(1200);
  });

  it('cancels an in-flight render on the same canvas and completes without error', async () => {
    const { renderer, renderMock } = setupFakePdfJs();
    let rejectFirst!: (reason?: unknown) => void;
    const cancelFirst = vi.fn(() => {
      const err = new Error('Rendering cancelled');
      err.name = 'RenderingCancelledException';
      rejectFirst(err);
    });
    const firstPromise = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });

    renderMock
      .mockReturnValueOnce({ promise: firstPromise, cancel: cancelFirst })
      .mockReturnValueOnce({ promise: Promise.resolve(undefined), cancel: vi.fn() });

    const handle = await firstValueFrom(renderer.open(new ArrayBuffer(8)));
    const canvas = document.createElement('canvas');

    let firstCompleted = false;
    let firstErrored = false;
    handle.renderPage(1, canvas, { cssWidth: 400, devicePixelRatio: 1 }).subscribe({
      error: () => {
        firstErrored = true;
      },
      complete: () => {
        firstCompleted = true;
      },
    });
    await Promise.resolve();

    await lastValueFrom(
      handle.renderPage(2, canvas, { cssWidth: 400, devicePixelRatio: 1 }),
    );

    expect(cancelFirst).toHaveBeenCalledTimes(1);
    expect(firstErrored).toBe(false);
    expect(firstCompleted).toBe(true);
  });

  it('cancels the render task when unsubscribed mid-render', async () => {
    const { renderer, renderMock } = setupFakePdfJs();
    const cancelMock = vi.fn();
    renderMock.mockReturnValue({
      promise: new Promise<void>(() => undefined),
      cancel: cancelMock,
    });

    const handle = await firstValueFrom(renderer.open(new ArrayBuffer(8)));
    const canvas = document.createElement('canvas');

    const sub = handle.renderPage(1, canvas, { cssWidth: 400 }).subscribe();
    await Promise.resolve();
    sub.unsubscribe();

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it('errors on out-of-range page numbers with a clear RangeError', async () => {
    const { renderer } = setupFakePdfJs();
    const handle = await firstValueFrom(renderer.open(new ArrayBuffer(8)));
    const canvas = document.createElement('canvas');

    await expect(
      lastValueFrom(handle.renderPage(0, canvas, { cssWidth: 400 })),
    ).rejects.toThrow(/out of range/u);
    await expect(
      lastValueFrom(handle.renderPage(3, canvas, { cssWidth: 400 })),
    ).rejects.toThrow(/out of range/u);
  });

  it('destroys the loading task once even when destroy() is called twice and skips later renders', async () => {
    const { renderer, loadingTaskDestroy, getPageMock } = setupFakePdfJs();
    const handle = await firstValueFrom(renderer.open(new ArrayBuffer(8)));

    handle.destroy();
    handle.destroy();

    expect(loadingTaskDestroy).toHaveBeenCalledTimes(1);

    const canvas = document.createElement('canvas');
    let completed = false;
    handle.renderPage(1, canvas, { cssWidth: 400 }).subscribe({
      complete: () => {
        completed = true;
      },
    });
    expect(completed).toBe(true);
    expect(getPageMock).not.toHaveBeenCalled();
  });
});
