import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map, type Subscription } from 'rxjs';
import type { DesktopLibraryDetail } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import {
  errorMessage,
  isPdfMediaType,
  transcriptLines,
  type TranscriptLine,
} from './desktop-workspace.selectors';
import { groupRawOcrPages, type OcrPageText } from './ocr-queue';
import {
  PdfPageRenderer,
  type PdfDocumentHandle,
} from './pdf-page-renderer.service';
import { playbackUnavailable as isPlaybackOverLimit } from './recording-playback';
import {
  buildResultDetails,
  buildResultSpeakers,
  isNotFoundError,
  resultKind,
  resultSpeakersList,
  resultStatusText,
  type ResultDetailsView,
  type ResultKind,
  type ResultSeekRequest,
  type ResultSpeakerView,
} from './result-review';

export type PdfPreviewState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Page-scoped state for `/history/:id` (provided by `ResultPage`, destroyed on leave).
 * Owns document loading, OCR page stepping, lazy Blob URL / PDF handle lifecycle, and seek state.
 */
@Injectable()
export class ResultReviewStore {
  private readonly route = inject(ActivatedRoute, { optional: true });
  private readonly library = inject(DesktopLibraryService);
  private readonly runtime = inject(DesktopRuntimeClientService, { optional: true });
  private readonly formatting = inject(DesktopWorkspaceFormattingService);
  private readonly pdfRenderer = inject(PdfPageRenderer);
  private readonly destroyRef = inject(DestroyRef);

  private readonly routeId = this.route
    ? toSignal(this.route.paramMap.pipe(map((params) => params.get('id'))), {
        initialValue: this.route.snapshot.paramMap.get('id'),
      })
    : signal<string | null>(null);

  readonly documentId = computed(() => {
    const id = this.routeId()?.trim();
    return id ? id : null;
  });

  private readonly runtimeReady = computed(() =>
    this.runtime ? this.runtime.started() : true,
  );

  private readonly detailResource = rxResource<
    DesktopLibraryDetail | null,
    { readonly documentId: string } | undefined
  >({
    defaultValue: null,
    params: () => {
      const documentId = this.documentId();
      return this.runtimeReady() && documentId ? { documentId } : undefined;
    },
    stream: ({ params, abortSignal }) =>
      this.library.get(params.documentId, abortSignal),
  });

  readonly detail = computed<DesktopLibraryDetail | null>(() =>
    this.detailResource.hasValue() ? this.detailResource.value() : null,
  );

  readonly loading = computed(() => {
    if (!this.documentId()) return false;
    return !this.runtimeReady() || this.detailResource.isLoading();
  });

  readonly notFound = computed(() => {
    if (!this.documentId()) return true;
    const error = this.detailResource.error();
    return error !== undefined && isNotFoundError(error);
  });

  readonly failed = computed(() => {
    const error = this.detailResource.error();
    return error !== undefined && !isNotFoundError(error);
  });

  readonly loadError = computed<string | null>(() => {
    if (this.notFound()) return desktopMessages().resultNotFound;
    const error = this.detailResource.error();
    return error !== undefined ? errorMessage(error) : null;
  });

  readonly kind = computed<ResultKind>(() => {
    const d = this.detail();
    return d ? resultKind(d.mediaType) : 'ocr';
  });

  readonly backRoute = computed(() => (this.kind() === 'asr' ? '/asr' : '/ocr'));

  readonly hasResult = computed(() => this.detail()?.raw !== undefined);

  readonly statusText = computed(() => {
    const d = this.detail();
    return d ? resultStatusText(d) : '';
  });

  readonly noResultReason = computed<string | null>(() => {
    const d = this.detail();
    if (!d || this.hasResult()) return null;
    return d.recoveryMessage ?? d.errorMessage ?? null;
  });

  // --- OCR state ---

  readonly pages = computed<readonly OcrPageText[]>(() => {
    const d = this.detail();
    if (!d?.raw || this.kind() !== 'ocr') return [];
    return groupRawOcrPages(d.raw);
  });

  private readonly selectedPageNumber = signal<number | null>(null);

  readonly currentPage = computed<OcrPageText | null>(() => {
    const list = this.pages();
    if (list.length === 0) return null;
    const selected = this.selectedPageNumber();
    return list.find((page) => page.page === selected) ?? list[0];
  });

  readonly currentPageIndex = computed(() => {
    const current = this.currentPage();
    if (!current) return -1;
    return this.pages().findIndex((page) => page.page === current.page);
  });

  readonly totalPages = computed(() => this.pages().length);

  readonly canPrevious = computed(() => this.currentPageIndex() > 0);

  readonly canNext = computed(() => {
    const index = this.currentPageIndex();
    return index >= 0 && index < this.pages().length - 1;
  });

  readonly isPdf = computed(() => {
    const d = this.detail();
    return d !== null && this.kind() === 'ocr' && isPdfMediaType(d.mediaType);
  });

  // --- PDF preview state ---

  private readonly pdfStateSignal = signal<PdfPreviewState>('idle');
  private readonly pdfHandleState = signal<PdfDocumentHandle | null>(null);
  private readonly pdfPageFailedState = signal(false);
  private readonly renderedPdfPageState = signal<number | null>(null);

  readonly pdfState = computed<PdfPreviewState>(() =>
    this.pdfPageFailedState() ? 'failed' : this.pdfStateSignal(),
  );

  readonly pdfError = computed<string | null>(() =>
    this.pdfState() === 'failed' ? desktopMessages().resultPdfPreviewFailed : null,
  );

  readonly renderedPdfPage = this.renderedPdfPageState.asReadonly();

  // --- Source Blob URL & media seek state ---

  private readonly blobUrlState = signal<{
    readonly documentId: string;
    readonly url: string;
  } | null>(null);
  private readonly sourceErrorState = signal<string | null>(null);
  private readonly mediaCanPlay = signal(false);
  private readonly pendingSeekMsState = signal<number | null>(null);
  private readonly activeSeekState = signal<ResultSeekRequest | null>(null);

  private sourceSubscription: Subscription | null = null;
  private loadingSourceForId: string | null = null;
  private seekSeq = 0;
  private pdfRenderSeq = 0;
  private destroyed = false;

  readonly imageUrl = computed<string | null>(() => {
    const d = this.detail();
    if (!d || this.kind() !== 'ocr' || this.isPdf()) return null;
    const state = this.blobUrlState();
    return state?.documentId === d.documentId ? state.url : null;
  });

  readonly playbackUnavailable = computed(() => {
    const d = this.detail();
    return d !== null && this.kind() === 'asr' && isPlaybackOverLimit(d.byteLength);
  });

  readonly playbackUnavailableMessage = computed<string | null>(() =>
    this.playbackUnavailable()
      ? desktopMessages().largeRecordingPlaybackUnavailable
      : null,
  );

  readonly recordingUrl = computed<string | null>(() => {
    const d = this.detail();
    if (!d || this.kind() !== 'asr' || this.playbackUnavailable()) return null;
    const state = this.blobUrlState();
    return state?.documentId === d.documentId ? state.url : null;
  });

  readonly isVideo = computed(() =>
    this.detail()?.mediaType.startsWith('video/') ?? false,
  );

  readonly sourceError = this.sourceErrorState.asReadonly();
  readonly pendingSeekMs = this.pendingSeekMsState.asReadonly();
  readonly activeSeek = this.activeSeekState.asReadonly();

  // --- ASR transcript & speakers ---

  readonly lines = computed<readonly TranscriptLine[]>(() => {
    const d = this.detail();
    if (!d?.raw || this.kind() !== 'asr') return [];
    return transcriptLines(d.raw, resultSpeakersList(d));
  });

  readonly speakers = computed<readonly ResultSpeakerView[]>(() => {
    const d = this.detail();
    if (!d || this.kind() !== 'asr' || !this.hasResult()) return [];
    return buildResultSpeakers(resultSpeakersList(d), this.recordingUrl());
  });

  // --- Details ---

  readonly details = computed<ResultDetailsView | null>(() => {
    const d = this.detail();
    if (!d) return null;
    return buildResultDetails(d, this.pages().length, this.formatting);
  });

  private readonly resetOnDocumentChange = effect(() => {
    const currentId = this.documentId();
    untracked(() => {
      const existing = this.blobUrlState();
      if (existing && existing.documentId !== currentId) {
        this.revokeCurrentSource();
      }
      if (this.loadingSourceForId !== null && this.loadingSourceForId !== currentId) {
        this.cancelInFlightSource();
      }
      this.destroyPdfHandle();
      this.pdfStateSignal.set('idle');
      this.pdfPageFailedState.set(false);
      this.renderedPdfPageState.set(null);
      this.pdfRenderSeq += 1;
      this.selectedPageNumber.set(null);
      this.sourceErrorState.set(null);
      this.mediaCanPlay.set(false);
      this.pendingSeekMsState.set(null);
      this.activeSeekState.set(null);
    });
  });

  constructor() {
    // Reference effect so Angular keeps it alive for the store's lifetime.
    void this.resetOnDocumentChange;
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.cancelInFlightSource();
      this.revokeCurrentSource();
      this.destroyPdfHandle();
    });
  }

  selectPage(page: number): void {
    if (this.pages().some((candidate) => candidate.page === page)) {
      this.pdfPageFailedState.set(false);
      this.selectedPageNumber.set(page);
    }
  }

  previousPage(): void {
    const index = this.currentPageIndex();
    if (index > 0) {
      this.pdfPageFailedState.set(false);
      this.selectedPageNumber.set(this.pages()[index - 1].page);
    }
  }

  nextPage(): void {
    const index = this.currentPageIndex();
    const list = this.pages();
    if (index >= 0 && index < list.length - 1) {
      this.pdfPageFailedState.set(false);
      this.selectedPageNumber.set(list[index + 1].page);
    }
  }

  /** Lazily fetches source bytes once per document when preview/playback is needed. */
  loadSource(): void {
    const d = this.detail();
    if (!d || !this.hasResult()) return;
    const isPdf = this.isPdf();
    if (isPdf && this.pdfStateSignal() !== 'idle') return;
    if (this.kind() === 'asr' && this.playbackUnavailable()) return;
    if (!isPdf && this.blobUrlState()?.documentId === d.documentId) return;
    if (this.loadingSourceForId === d.documentId) return;

    this.cancelInFlightSource();
    this.sourceErrorState.set(null);
    if (isPdf) {
      this.pdfStateSignal.set('loading');
    }
    this.loadingSourceForId = d.documentId;
    const requestedId = d.documentId;
    const mediaType = d.mediaType;

    this.sourceSubscription = this.library.sourceBytes(requestedId).subscribe({
      next: (bytes) => {
        this.loadingSourceForId = null;
        this.sourceSubscription = null;
        if (this.documentId() !== requestedId || this.destroyed) return;
        if (isPdf) {
          void this.openPdfBytes(requestedId, bytes);
          return;
        }
        this.revokeCurrentSource();
        const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
        this.blobUrlState.set({ documentId: requestedId, url });
      },
      error: (error: unknown) => {
        this.loadingSourceForId = null;
        this.sourceSubscription = null;
        if (this.documentId() !== requestedId || this.destroyed) return;
        if (isPdf) {
          this.pdfStateSignal.set('failed');
          return;
        }
        this.sourceErrorState.set(errorMessage(error));
      },
    });
  }

  /** Renders the active OCR page's source page number onto `canvas`. */
  renderCurrentPdfPage(canvas: HTMLCanvasElement, cssWidth: number): void {
    const handle = this.pdfHandleState();
    const page = this.currentPage();
    const requestedId = this.documentId();
    if (!handle || !page || !requestedId || !this.isPdf()) return;

    const pageNumber = page.page;
    if (pageNumber < 1 || pageNumber > handle.pageCount) {
      this.pdfPageFailedState.set(true);
      this.renderedPdfPageState.set(null);
      return;
    }

    this.pdfPageFailedState.set(false);
    const seq = ++this.pdfRenderSeq;
    const dpr =
      typeof globalThis.devicePixelRatio === 'number'
        ? globalThis.devicePixelRatio
        : 1;

    void handle
      .renderPage(pageNumber, canvas, { cssWidth, devicePixelRatio: dpr })
      .then(() => {
        if (
          this.destroyed ||
          this.pdfRenderSeq !== seq ||
          this.documentId() !== requestedId ||
          this.pdfHandleState() !== handle ||
          this.currentPage()?.page !== pageNumber
        ) {
          return;
        }
        this.renderedPdfPageState.set(pageNumber);
      })
      .catch(() => {
        if (
          this.destroyed ||
          this.pdfRenderSeq !== seq ||
          this.documentId() !== requestedId ||
          this.pdfHandleState() !== handle ||
          this.currentPage()?.page !== pageNumber
        ) {
          return;
        }
        this.pdfPageFailedState.set(true);
        this.renderedPdfPageState.set(null);
      });
  }

  /** Requests seeking the media player to `ms`, deferring until `canplay` if needed. */
  requestSeek(ms: number): void {
    if (this.playbackUnavailable()) return;
    this.loadSource();
    if (this.mediaCanPlay() && this.recordingUrl() !== null) {
      this.pendingSeekMsState.set(null);
      this.activeSeekState.set({ ms, seq: ++this.seekSeq });
      return;
    }
    this.pendingSeekMsState.set(ms);
  }

  /** Called by the media element when it can play; flushes any deferred seek. */
  onMediaCanPlay(): void {
    this.mediaCanPlay.set(true);
    const pending = this.pendingSeekMsState();
    if (pending !== null) {
      this.pendingSeekMsState.set(null);
      this.activeSeekState.set({ ms: pending, seq: ++this.seekSeq });
    }
  }

  private async openPdfBytes(requestedId: string, bytes: ArrayBuffer): Promise<void> {
    try {
      const handle = await this.pdfRenderer.open(bytes);
      if (this.documentId() !== requestedId || this.destroyed) {
        void handle.destroy();
        return;
      }
      this.destroyPdfHandle();
      this.pdfHandleState.set(handle);
      this.pdfStateSignal.set('ready');
    } catch {
      if (this.documentId() !== requestedId || this.destroyed) return;
      this.pdfStateSignal.set('failed');
    }
  }

  private destroyPdfHandle(): void {
    const handle = this.pdfHandleState();
    if (handle) {
      this.pdfHandleState.set(null);
      void handle.destroy();
    }
  }

  private cancelInFlightSource(): void {
    this.sourceSubscription?.unsubscribe();
    this.sourceSubscription = null;
    this.loadingSourceForId = null;
  }

  private revokeCurrentSource(): void {
    const existing = this.blobUrlState();
    if (existing) {
      URL.revokeObjectURL(existing.url);
      this.blobUrlState.set(null);
    }
  }
}
