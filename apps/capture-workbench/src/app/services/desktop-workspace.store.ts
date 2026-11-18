import { selectionRejectionMessages } from './source-selection-messages';
import { computed, DestroyRef, effect, Injectable, inject, Injector, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { AsrQueueStore } from './asr-queue.store';
import { OcrQueueStore } from './ocr-queue.store';
import { SpeechGpuSettingsStore } from './speech-gpu-settings.store';
import { DesktopLibraryService, type DesktopSourceSelectionBatch } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import {
  DesktopCaptureService,
  type DesktopCaptureHost,
} from './desktop-capture.service';
import { LibraryStore } from './library.store';
import { RecognitionFeaturesStore } from './recognition-features.store';
import { errorMessage } from './desktop-workspace.selectors';
import { desktopMessages } from '../i18n/desktop-messages';

type WorkspaceState = 'starting' | 'ready' | 'error';

@Injectable({ providedIn: 'root' })
/** Public Angular facade for workspace state, commands, and capture actions. */
export class DesktopWorkspaceStore {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly captureLifecycle = inject(DesktopCaptureService);
  private readonly compute = inject(SpeechGpuSettingsStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router, { optional: true });
  private readonly features = inject(RecognitionFeaturesStore);

  readonly message = signal(desktopMessages().starting);

  readonly state = computed<WorkspaceState>(() => {
    if (
      this.runtime.error() ||
      this.features.requirementsResource.error() ||
      this.libraryStore.listError()
    ) {
      return 'error';
    }
    if (!this.runtime.started()) return 'starting';
    const requirementsStatus = this.features.requirementsResource.status();
    if (
      requirementsStatus === 'idle' ||
      requirementsStatus === 'loading' ||
      requirementsStatus === 'reloading'
    ) {
      return 'starting';
    }
    return 'ready';
  });

  /** Installing one feature does not block capturing with another (plan §2, ASR journey). */
  readonly canCapture = computed(() => this.state() === 'ready');

  private dropListenerStarted = false;

  private readonly libraryStore = inject(LibraryStore);

  private readonly captureHost: DesktopCaptureHost = {
    selectedId: this.libraryStore.selectedId,
    requestedRequirements: this.features.requestedRequirements,
    requirements: () => this.features.requirements(),
    documents: () => this.libraryStore.allDocuments() ?? [],
    selected: () => this.libraryStore.selected(),
    refreshDocuments: () => this.libraryStore.refreshDocuments(),
    reloadDocumentState: (documentId) => this.libraryStore.reloadDocumentState(documentId),
    setMessage: (message) => this.message.set(message),
    identifySpeakers: () => false,
  };

  private readonly resourceErrorEffect = effect(() => {
    const error =
      this.runtime.error() ??
      this.features.requirementsResource.error() ??
      this.libraryStore.listError() ??
      this.libraryStore.detailError();
    if (error) this.message.set(errorMessage(error));
  });

  private readonly stateMessageEffect = effect(() => {
    const state = this.state();
    if (state === 'ready' && this.message() === desktopMessages().starting) {
      this.message.set('');
    }
  });

  private readonly featureMessageEffect = effect(() => {
    const featureMsg = this.features.message();
    if (featureMsg) {
      this.message.set(featureMsg);
    }
  });

  private readonly computeErrorEffect = effect(() => {
    const computeError = this.compute.error();
    if (computeError) {
      this.message.set(computeError);
    }
  });

  /** Starts runtime readiness, requirement, model, and document resources. */
  initialize(): void {
    if (!this.dropListenerStarted) {
      this.dropListenerStarted = true;
      this.library
        .droppedSources()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (batch) => this.routeDroppedSources(batch),
          error: (error: unknown) => this.message.set(errorMessage(error)),
        });
    }
    this.runtime.reload();
    this.compute.reload();
    this.features.initialize();
    this.libraryStore.refreshDocuments();
  }

  /** Enqueues selections through the capture lifecycle collaborator. */
  addSelections(batch: DesktopSourceSelectionBatch): void {
    this.message.set(selectionRejectionMessages(batch).join('\n'));
    if (!this.runtime.ready() || !this.canCapture()) {
      this.library.discardSelections(batch.selections).subscribe({ error: () => undefined });
      return;
    }
    this.captureLifecycle.addSelections$(batch.selections, this.captureHost).subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  /**
   * The one drag-drop subscription. On `/ocr` or `/asr` the selections wait in that
   * page's queue. Anywhere else they start capture, as this workspace always did.
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
    this.addSelections(batch);
  }

  private currentRoutePath(): string {
    return (this.router?.url ?? '').split(/[?#]/u)[0] ?? '';
  }
}
