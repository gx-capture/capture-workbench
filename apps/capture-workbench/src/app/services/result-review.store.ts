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
import { defer, map, Observable, of, Subject, throwError, timer, type Subscription } from 'rxjs';
import type { DesktopLibraryDetail, DesktopLibraryEdits } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import {
  errorMessage,
  isPdfMediaType,
} from './desktop-workspace.selectors';
import {
  PdfPageRenderer,
  type PdfDocumentHandle,
} from './pdf-page-renderer.service';
import { playbackUnavailable as isPlaybackOverLimit } from './recording-playback';
import {
  applyResultEdit,
  sameResultEdits,
  type ResultEditCommand,
  buildResultDetails,
  buildResultSpeakers,
  resultPages,
  resultLines,
  type EditedOcrPage,
  type EditedTranscriptLine,
  isNotFoundError,
  resultKind,
  resultSpeakersList,
  resultStatusText,
  type ResultDetailsView,
  type ResultKind,
  type ResultSeekRequest,
  type ResultSpeakerView,
} from './result-review';

interface EditSession {
  readonly id: string;
  working: DesktopLibraryEdits;
  saved: DesktopLibraryEdits;
  inFlight: boolean;
  timer: Subscription | null;
}

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

  private session: EditSession | null = null;
  private activeSave: EditSession | null = null;
  private readonly queuedSaves = new Set<EditSession>();
  private readonly editSessions = new Map<string, EditSession>();
  private readonly workingEdits = signal<DesktopLibraryEdits>({
    schemaVersion: 1, updatedAtMs: 0, ocrPages: {}, transcriptLines: {}, speakerNames: {},
  });
  readonly saveState = signal<'idle' | 'pending' | 'saving' | 'saved' | 'failed'>('idle');
  readonly saveError = signal<string | null>(null);
  readonly editError = signal<string | null>(null);
  readonly editsNotice = computed(() => this.editsUnreadable() ? desktopMessages().resultEditsUnreadable : null);

  private readonly syncEdits = effect(() => {
    const id = this.documentId();
    const detail = this.detail();
    untracked(() => {
      if (this.session && this.session.id !== id) {
        this.leaveEdits(this.session);
        this.session = null;
      }
      if (!detail || detail.documentId !== id) return;
      const retained = this.editSessions.get(detail.documentId);
      if (!this.session && retained && (retained.inFlight || !sameResultEdits(retained.working, retained.saved))) {
        this.session = retained;
        this.workingEdits.set(retained.working);
        this.saveState.set(retained.inFlight ? 'saving' : 'pending');
        this.saveError.set(null);
        this.editError.set(null);
        this.saveEdits(retained);
        return;
      }
      if (this.session && (!sameResultEdits(this.session.working, this.session.saved) || this.session.inFlight)) return;
      const edits: DesktopLibraryEdits = detail.edits ?? {
        schemaVersion: 1, updatedAtMs: 0, ocrPages: {}, transcriptLines: {}, speakerNames: {},
      };
      this.session = { id: detail.documentId, working: edits, saved: edits, inFlight: false, timer: null };
      this.editSessions.set(detail.documentId, this.session);
      this.workingEdits.set(edits);
      this.saveState.set('idle');
      this.saveError.set(null);
      this.editError.set(null);
    });
  });

  editPage(page: number, text: string): void { this.changeEdit({ field: 'ocrPages', key: page, text }); }
  restorePage(page: number): void { this.changeEdit({ field: 'ocrPages', key: page, text: null }); }
  editLine(segmentId: string, text: string): void { this.changeEdit({ field: 'transcriptLines', key: segmentId, text }); }
  restoreLine(segmentId: string): void { this.changeEdit({ field: 'transcriptLines', key: segmentId, text: null }); }
  nameSpeaker(speakerId: string, text: string): void { this.changeEdit({ field: 'speakerNames', key: speakerId, text }); }
  retrySave(): void {
    if (this.session) {
      this.session.timer?.unsubscribe();
      this.session.timer = null;
      this.saveEdits(this.session);
    }
  }

  /** Flush through the existing serialized writer, including edits made during a save. */
  saveBeforeExport(): Observable<void> {
    return defer(() => {
      const session = this.session;
      if (!session || session.id !== this.documentId()) return throwError(() => new Error('save unavailable'));
      if (!session.inFlight && sameResultEdits(session.working, session.saved)) return of(undefined);
      return new Observable<void>((subscriber) => {
        const subscription = this.saveSettled.subscribe(({ savedSession, success }) => {
          if (savedSession !== session) return;
          if (!success) subscriber.error(new Error('save failed'));
          else { subscriber.next(undefined); subscriber.complete(); }
        });
        session.timer?.unsubscribe();
        session.timer = null;
        this.saveEdits(session);
        return subscription;
      });
    });
  }

  private readonly saveSettled = new Subject<{ savedSession: EditSession; success: boolean }>();

  private changeEdit(command: ResultEditCommand): void {
    const session = this.session;
    const detail = this.detail();
    if (!session || !detail || session.id !== this.documentId()) return;
    const result = applyResultEdit(detail, session.working, command);
    this.editError.set(result.error);
    if (result.error || sameResultEdits(session.working, result.edits)) return;
    session.working = result.edits;
    this.workingEdits.set(result.edits);
    this.saveError.set(null);
    session.timer?.unsubscribe();
    session.timer = null;
    if (session.inFlight) return;
    if (sameResultEdits(session.working, session.saved)) {
      this.saveState.set('idle');
      return;
    }
    this.saveState.set('pending');
    session.timer = timer(600).subscribe(() => {
      session.timer = null;
      this.saveEdits(session);
    });
  }

  private leaveEdits(session: EditSession): void {
    session.timer?.unsubscribe();
    session.timer = null;
    this.saveEdits(session);
  }

  private saveEdits(session: EditSession): void {
    if (session.inFlight) return;
    const visible = () => this.session === session && !this.destroyed && this.documentId() === session.id;
    if (sameResultEdits(session.working, session.saved)) {
      if (visible() && this.saveState() === 'failed') {
        this.saveState.set('idle');
        this.saveError.set(null);
      }
      this.saveSettled.next({ savedSession: session, success: true });
      return;
    }
    if (this.activeSave) {
      this.queuedSaves.add(session);
      if (this.session === session && !this.destroyed) this.saveState.set('pending');
      return;
    }
    const snapshot = session.working;
    this.activeSave = session;
    session.inFlight = true;
    if (visible()) { this.saveState.set('saving'); this.saveError.set(null); }
    this.library.saveEdits(session.id, snapshot).subscribe({
      next: () => { session.saved = snapshot; },
      error: () => {
        const clean = sameResultEdits(session.working, session.saved);
        if (visible()) {
          this.saveState.set(clean ? 'idle' : 'failed');
          this.saveError.set(clean ? null : desktopMessages().resultSaveFailed);
        }
        this.saveSettled.next({ savedSession: session, success: clean });
        this.finishSave(session, !sameResultEdits(snapshot, session.working));
      },
      complete: () => {
        if (visible() && sameResultEdits(session.working, session.saved)) this.saveState.set('saved');
        this.finishSave(session, true);
        if (!session.inFlight && sameResultEdits(session.working, session.saved)) {
          this.saveSettled.next({ savedSession: session, success: true });
        }
      },
    });
  }

  private finishSave(session: EditSession, saveNewer: boolean): void {
    session.inFlight = false;
    this.activeSave = null;
    if (saveNewer && !sameResultEdits(session.working, session.saved)) this.queuedSaves.add(session);
    // Only one request can run, including saves flushed for a previous document.
    for (const queued of this.queuedSaves) {
      this.queuedSaves.delete(queued);
      this.saveEdits(queued);
      if (this.activeSave) break;
    }
  }

  // --- OCR state ---

  readonly editsUnreadable = computed(() => this.detail()?.editsUnreadable === true);

  readonly pages = computed<readonly EditedOcrPage[]>(() => {
    const d = this.detail();
    if (!d?.raw || this.kind() !== 'ocr') return [];
    return resultPages(d.raw, this.workingEdits());
  });

  private readonly selectedPageNumber = signal<number | null>(null);

  readonly currentPage = computed<EditedOcrPage | null>(() => {
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
  private pdfOpenSubscription: Subscription | null = null;
  private pdfRenderSubscription: Subscription | null = null;
  private loadingSourceForId: string | null = null;
  private seekSeq = 0;
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

  readonly lines = computed<readonly EditedTranscriptLine[]>(() => {
    const d = this.detail();
    if (!d?.raw || this.kind() !== 'asr') return [];
    return resultLines(d.raw, resultSpeakersList(d), this.workingEdits());
  });

  readonly speakers = computed<readonly ResultSpeakerView[]>(() => {
    const d = this.detail();
    if (!d || this.kind() !== 'asr' || !this.hasResult()) return [];
    return buildResultSpeakers(resultSpeakersList(d), this.recordingUrl(), this.workingEdits());
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
      this.cancelPdfWork();
      this.destroyPdfHandle();
      this.pdfStateSignal.set('idle');
      this.pdfPageFailedState.set(false);
      this.renderedPdfPageState.set(null);
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
    void this.syncEdits;
    this.destroyRef.onDestroy(() => {
      if (this.session) this.leaveEdits(this.session);
      this.destroyed = true;
      this.cancelInFlightSource();
      this.cancelPdfWork();
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
          this.openPdfBytes(requestedId, bytes);
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
    this.pdfRenderSubscription?.unsubscribe();
    this.pdfRenderSubscription = null;

    if (pageNumber < 1 || pageNumber > handle.pageCount) {
      this.pdfPageFailedState.set(true);
      this.renderedPdfPageState.set(null);
      return;
    }

    this.pdfPageFailedState.set(false);
    const dpr =
      typeof globalThis.devicePixelRatio === 'number'
        ? globalThis.devicePixelRatio
        : 1;

    this.pdfRenderSubscription = handle
      .renderPage(pageNumber, canvas, { cssWidth, devicePixelRatio: dpr })
      .subscribe({
        next: () => {
          if (
            this.destroyed ||
            this.documentId() !== requestedId ||
            this.pdfHandleState() !== handle ||
            this.currentPage()?.page !== pageNumber
          ) {
            return;
          }
          this.renderedPdfPageState.set(pageNumber);
        },
        error: () => {
          this.pdfRenderSubscription = null;
          if (
            this.destroyed ||
            this.documentId() !== requestedId ||
            this.pdfHandleState() !== handle ||
            this.currentPage()?.page !== pageNumber
          ) {
            return;
          }
          this.pdfPageFailedState.set(true);
          this.renderedPdfPageState.set(null);
        },
        complete: () => {
          this.pdfRenderSubscription = null;
        },
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

  private openPdfBytes(requestedId: string, bytes: ArrayBuffer): void {
    this.pdfOpenSubscription?.unsubscribe();
    this.pdfOpenSubscription = this.pdfRenderer.open(bytes).subscribe({
      next: (handle) => {
        this.pdfOpenSubscription = null;
        if (this.documentId() !== requestedId || this.destroyed) {
          handle.destroy();
          return;
        }
        this.destroyPdfHandle();
        this.pdfHandleState.set(handle);
        this.pdfStateSignal.set('ready');
      },
      error: () => {
        this.pdfOpenSubscription = null;
        if (this.documentId() !== requestedId || this.destroyed) return;
        this.pdfStateSignal.set('failed');
      },
    });
  }

  private destroyPdfHandle(): void {
    const handle = this.pdfHandleState();
    if (handle) {
      this.pdfHandleState.set(null);
      handle.destroy();
    }
  }

  private cancelPdfWork(): void {
    this.pdfOpenSubscription?.unsubscribe();
    this.pdfOpenSubscription = null;
    this.pdfRenderSubscription?.unsubscribe();
    this.pdfRenderSubscription = null;
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
