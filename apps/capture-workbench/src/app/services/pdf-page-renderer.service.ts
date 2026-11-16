import { inject, Injectable, InjectionToken } from '@angular/core';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';

export const MAX_PDF_DEVICE_PIXEL_RATIO = 2;
export const MAX_PDF_CANVAS_PIXELS = 16_000_000;

export interface PdfJsApi {
  readonly GlobalWorkerOptions: { workerSrc: string };
  readonly getDocument: typeof import('pdfjs-dist').getDocument;
}

export type PdfJsLoader = () => Promise<PdfJsApi>;

export const PDF_JS_LOADER = new InjectionToken<PdfJsLoader>('PDF_JS_LOADER', {
  providedIn: 'root',
  factory: () => () => import('pdfjs-dist'),
});

export interface PdfRenderDimensions {
  readonly scale: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface PdfRenderOptions {
  readonly cssWidth: number;
  readonly devicePixelRatio?: number;
  readonly maxCanvasPixels?: number;
}

export interface PdfDocumentHandle {
  readonly pageCount: number;
  renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    options: PdfRenderOptions,
  ): Promise<void>;
  destroy(): Promise<void>;
}

/** Returns true when `pageNumber` is a 1-based integer within `1..pageCount`. */
export function isPdfPageInBounds(pageNumber: number, pageCount: number): boolean {
  return (
    Number.isInteger(pageNumber) &&
    pageCount >= 1 &&
    pageNumber >= 1 &&
    pageNumber <= pageCount
  );
}

/**
 * Computes the pdf.js viewport scale and backing canvas dimensions to fit
 * `targetCssWidth` at `devicePixelRatio` (capped at 2) within `maxCanvasPixels`.
 */
export function computePdfRenderScale(params: {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly targetCssWidth: number;
  readonly devicePixelRatio?: number;
  readonly maxCanvasPixels?: number;
}): PdfRenderDimensions {
  const { pageWidth, pageHeight, targetCssWidth } = params;
  if (
    !Number.isFinite(pageWidth) ||
    !Number.isFinite(pageHeight) ||
    pageWidth <= 0 ||
    pageHeight <= 0
  ) {
    return { scale: 1, cssWidth: 0, cssHeight: 0, pixelWidth: 0, pixelHeight: 0 };
  }

  const effectiveCssWidth =
    Number.isFinite(targetCssWidth) && targetCssWidth > 0 ? targetCssWidth : pageWidth;
  const cssScale = effectiveCssWidth / pageWidth;
  const cssWidth = effectiveCssWidth;
  const cssHeight = pageHeight * cssScale;

  const rawDpr = params.devicePixelRatio ?? 1;
  const dpr = Math.min(
    MAX_PDF_DEVICE_PIXEL_RATIO,
    Math.max(1, Number.isFinite(rawDpr) ? rawDpr : 1),
  );

  const maxPixels =
    params.maxCanvasPixels !== undefined &&
    Number.isFinite(params.maxCanvasPixels) &&
    params.maxCanvasPixels > 0
      ? params.maxCanvasPixels
      : MAX_PDF_CANVAS_PIXELS;

  let scale = cssScale * dpr;
  let pixelWidth = Math.max(1, Math.floor(pageWidth * scale));
  let pixelHeight = Math.max(1, Math.floor(pageHeight * scale));

  const totalPixels = pixelWidth * pixelHeight;
  if (totalPixels > maxPixels) {
    const capFactor = Math.sqrt(maxPixels / totalPixels);
    scale *= capFactor;
    pixelWidth = Math.max(1, Math.floor(pageWidth * scale));
    pixelHeight = Math.max(1, Math.floor(pageHeight * scale));
  }

  return { scale, cssWidth, cssHeight, pixelWidth, pixelHeight };
}

function pdfjsAssetUrl(relativePath: string): string {
  const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  const base =
    typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : 'http://localhost/';
  return new URL(normalized, base).href;
}

function isRenderingCancelledError(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

interface ActiveRender {
  cancelled: boolean;
  task: RenderTask | null;
}

function createDocumentHandle(
  doc: PDFDocumentProxy,
  loadingTask: PDFDocumentLoadingTask,
): PdfDocumentHandle {
  const activeRenders = new Map<HTMLCanvasElement, ActiveRender>();
  let destroyed = false;
  let destroyPromise: Promise<void> | null = null;

  return {
    pageCount: doc.numPages,

    async renderPage(
      pageNumber: number,
      canvas: HTMLCanvasElement,
      options: PdfRenderOptions,
    ): Promise<void> {
      if (destroyed) return;
      if (!isPdfPageInBounds(pageNumber, doc.numPages)) {
        throw new RangeError(
          `PDF page ${pageNumber} is out of range (1..${doc.numPages}).`,
        );
      }

      const previous = activeRenders.get(canvas);
      if (previous) {
        previous.cancelled = true;
        previous.task?.cancel();
      }

      const current: ActiveRender = { cancelled: false, task: null };
      activeRenders.set(canvas, current);

      try {
        const page: PDFPageProxy = await doc.getPage(pageNumber);
        if (current.cancelled || destroyed) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const dims = computePdfRenderScale({
          pageWidth: baseViewport.width,
          pageHeight: baseViewport.height,
          targetCssWidth: options.cssWidth,
          devicePixelRatio: options.devicePixelRatio,
          maxCanvasPixels: options.maxCanvasPixels,
        });

        canvas.width = dims.pixelWidth;
        canvas.height = dims.pixelHeight;

        const viewport = page.getViewport({ scale: dims.scale });
        const task = page.render({ canvas, viewport });
        current.task = task;
        await task.promise;
      } catch (error: unknown) {
        if (current.cancelled || destroyed || isRenderingCancelledError(error)) {
          return;
        }
        throw error;
      } finally {
        if (activeRenders.get(canvas) === current) {
          activeRenders.delete(canvas);
        }
      }
    },

    destroy(): Promise<void> {
      if (destroyPromise) return destroyPromise;
      destroyed = true;
      for (const active of activeRenders.values()) {
        active.cancelled = true;
        active.task?.cancel();
      }
      activeRenders.clear();
      // Destroying the loading task also destroys the document and its worker.
      destroyPromise = loadingTask.destroy().catch(() => undefined);
      return destroyPromise;
    },
  };
}

/**
 * Lazily loads pdf.js and renders PDF pages onto canvases under the desktop CSP
 * (no CDN, no WebAssembly, local worker/cmaps/standard_fonts/wasm-fallback assets).
 */
@Injectable({ providedIn: 'root' })
export class PdfPageRenderer {
  private readonly loadPdfJs = inject(PDF_JS_LOADER);
  private pdfjsPromise: Promise<PdfJsApi> | null = null;

  async open(bytes: ArrayBuffer): Promise<PdfDocumentHandle> {
    const pdfjs = await this.ensurePdfJs();
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsAssetUrl(
      'assets/pdfjs/pdf.worker.min.mjs',
    );

    const data = new Uint8Array(bytes.slice(0));
    const loadingTask = pdfjs.getDocument({
      data,
      useWasm: false,
      wasmUrl: pdfjsAssetUrl('assets/pdfjs/wasm/'),
      cMapUrl: pdfjsAssetUrl('assets/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsAssetUrl('assets/pdfjs/standard_fonts/'),
    });

    const doc = await loadingTask.promise;
    return createDocumentHandle(doc, loadingTask);
  }

  private ensurePdfJs(): Promise<PdfJsApi> {
    if (!this.pdfjsPromise) {
      this.pdfjsPromise = this.loadPdfJs().catch((error: unknown) => {
        this.pdfjsPromise = null;
        throw error;
      });
    }
    return this.pdfjsPromise;
  }
}
