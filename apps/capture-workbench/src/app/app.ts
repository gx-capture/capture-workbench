import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  Injector,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, switchMap, take } from 'rxjs';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { desktopMessages, type ShellRoute } from './i18n/desktop-messages';
import { AsrQueueStore } from './services/asr-queue.store';
import { DesktopCaptureService, type DesktopCaptureHost } from './services/desktop-capture.service';
import { DesktopLibraryService, type DesktopSourceSelectionBatch } from './services/desktop-library.service';
import { DesktopRuntimeClientService } from './services/desktop-runtime-client.service';
import { errorMessage } from './services/desktop-errors';
import { LibraryStore } from './services/library.store';
import { OcrQueueStore } from './services/ocr-queue.store';
import { RecognitionFeaturesStore } from './services/recognition-features.store';
import { RuntimeStatusStore } from './services/runtime-status.store';
import { selectionRejectionMessages } from './services/source-selection-messages';

const SHELL_ROUTES: readonly ShellRoute[] = [
  'ocr',
  'asr',
  'history',
  'settings',
];

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly captureLifecycle = inject(DesktopCaptureService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly features = inject(RecognitionFeaturesStore);
  private readonly libraryStore = inject(LibraryStore);

  protected readonly runtimeStatus = inject(RuntimeStatusStore);
  protected readonly m = desktopMessages;
  protected readonly navItems = computed(() =>
    SHELL_ROUTES.map((route) => ({ route, label: this.m().nav[route] })),
  );

  private readonly captureHost: DesktopCaptureHost = {
    selectedId: this.libraryStore.selectedId,
    requestedRequirements: this.features.requestedRequirements,
    requirements: () => this.features.requirements(),
    refreshDocuments: () => this.libraryStore.refreshDocuments(),
    applyDocumentState: (summary) => this.libraryStore.applyDocumentState(summary),
    setMessage: (message) => this.runtimeStatus.message.set(message),
  };

  constructor() {
    this.library
      .droppedSources()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (batch) => this.routeDroppedSources(batch),
        error: (error: unknown) => this.runtimeStatus.message.set(errorMessage(error)),
      });
    // Once per app run, when the runtime is first ready: the runs that
    // started the captures still linked in the library have ended.
    toObservable(this.runtime.ready, { injector: this.injector })
      .pipe(
        filter(Boolean),
        take(1),
        switchMap(() => this.captureLifecycle.deleteLinkedRuntimeCaptures$()),
        takeUntilDestroyed(this.destroyRef),
      )
      // Best effort: what is not deleted now the runtime's retention removes.
      .subscribe({ error: () => undefined });
    // The one admission of waiting documents, from app start and on every
    // page: it looks again whenever the list, the requirements or the
    // runtime's readiness change.
    const admissionChanges = computed(() => [
      this.libraryStore.allDocuments(),
      this.features.requirements(),
      this.runtime.ready(),
    ]);
    this.captureLifecycle
      .admitWaiting$(this.captureHost, toObservable(admissionChanges, { injector: this.injector }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: (error: unknown) => this.runtimeStatus.message.set(errorMessage(error)) });
    this.runtimeStatus.reload();
  }

  private captureDroppedSources(batch: DesktopSourceSelectionBatch): void {
    this.runtimeStatus.message.set(selectionRejectionMessages(batch).join('\n'));
    if (!this.runtime.ready() || this.runtimeStatus.state() !== 'ready') {
      this.library.discardSelections(batch.selections).subscribe({ error: () => undefined });
      return;
    }
    this.captureLifecycle.addSelections$(batch.selections, this.captureHost).subscribe({
      error: (error: unknown) => this.runtimeStatus.message.set(errorMessage(error)),
    });
  }

  /**
   * The one drag-drop subscription. On `/ocr` or `/asr` that page's queue
   * imports the selections; on other routes the shell does. Either way they
   * wait for the admission.
   */
  private routeDroppedSources(batch: DesktopSourceSelectionBatch): void {
    const path = this.currentRoutePath();
    if (path === '/ocr') {
      this.injector.get(OcrQueueStore).importSelections(batch);
      return;
    }
    if (path === '/asr') {
      this.injector.get(AsrQueueStore).importSelections(batch);
      return;
    }
    this.captureDroppedSources(batch);
  }

  private currentRoutePath(): string {
    return this.router.url.split(/[?#]/u)[0] ?? '';
  }
}
