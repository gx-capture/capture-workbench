import { inject, Injectable, InjectionToken } from '@angular/core';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import {
  catchError,
  defer,
  EMPTY,
  from,
  Observable,
  shareReplay,
  switchMap,
  throwError,
} from 'rxjs';

export const MAX_PDF_DEVICE_PIXEL_RATIO = 2;
export const MAX_PDF_CANVAS_PIXELS = 16_000_000;

export interface PdfJsApi {
  readonly GlobalWorkerOptions: { workerSrc: string };
  readonly getDocument: typeof import('pdfjs-dist').getDocument;
}

export type PdfJsLoader = () => Observable<PdfJsApi>;

export const PDF_JS_LOADER = new InjectionToken<PdfJsLoader>('PDF_JS_LOADER', {
  providedIn: 'root',
  factory: () => () => defer(() => from(import('pdfjs-dist'))),
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
  ): Observable<void>;
  destroy(): void;
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

  return {
    pageCount: doc.numPages,

    renderPage(
      pageNumber: number,
      canvas: HTMLCanvasElement,
      options: PdfRenderOptions,
    ): Observable<void> {
      return new Observable<void>((subscriber) => {
        if (destroyed) {
          subscriber.complete();
          return;
        }
        if (!isPdfPageInBounds(pageNumber, doc.numPages)) {
          subscriber.error(
            new RangeError(
              `PDF page ${pageNumber} is out of range (1..${doc.numPages}).`,
            ),
          );
          return;
        }

        const previous = activeRenders.get(canvas);
        if (previous) {
          previous.cancelled = true;
          previous.task?.cancel();
        }

        const current: ActiveRender = { cancelled: false, task: null };
        activeRenders.set(canvas, current);
        let finished = false;

        const cleanupActive = () => {
          if (activeRenders.get(canvas) === current) {
            activeRenders.delete(canvas);
          }
        };

        const renderSub = from(doc.getPage(pageNumber))
          .pipe(
            switchMap((page: PDFPageProxy) => {
              if (current.cancelled || destroyed) {
                return EMPTY;
              }

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
              return from(task.promise);
            }),
            catchError((error: unknown) => {
              if (current.cancelled || destroyed || isRenderingCancelledError(error)) {
                return EMPTY;
              }
              return throwError(() => error);
            }),
          )
          .subscribe({
            next: () => {
              finished = true;
              cleanupActive();
              subscriber.next();
              subscriber.complete();
            },
            error: (error: unknown) => {
              finished = true;
              cleanupActive();
              subscriber.error(error);
            },
            complete: () => {
              finished = true;
              cleanupActive();
              subscriber.complete();
            },
          });

        return () => {
          if (!finished) {
            current.cancelled = true;
            current.task?.cancel();
          }
          renderSub.unsubscribe();
          cleanupActive();
        };
      });
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const active of activeRenders.values()) {
        active.cancelled = true;
        active.task?.cancel();
      }
      activeRenders.clear();
      // Destroying the loading task also destroys the document and its worker.
      void loadingTask.destroy().catch(() => undefined);
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
  private pdfjs$: Observable<PdfJsApi> | null = null;

  open(bytes: ArrayBuffer): Observable<PdfDocumentHandle> {
    return this.ensurePdfJs().pipe(
      switchMap(
        (pdfjs) =>
          new Observable<PdfDocumentHandle>((subscriber) => {
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

            let settled = false;
            const loadSub = from(loadingTask.promise).subscribe({
              next: (doc) => {
                settled = true;
                subscriber.next(createDocumentHandle(doc, loadingTask));
                subscriber.complete();
              },
              error: (error: unknown) => {
                settled = true;
                subscriber.error(error);
              },
            });

            return () => {
              loadSub.unsubscribe();
              if (!settled) {
                void loadingTask.destroy().catch(() => undefined);
              }
            };
          }),
      ),
    );
  }

  private ensurePdfJs(): Observable<PdfJsApi> {
    if (!this.pdfjs$) {
      this.pdfjs$ = this.loadPdfJs().pipe(
        catchError((error: unknown) => {
          this.pdfjs$ = null;
          return throwError(() => error);
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.pdfjs$;
  }
}
