import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { finalize } from 'rxjs';
import type { DesktopLibraryDetail } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
import {
  buildDiagnosticsDocumentView,
  buildDiagnosticsRuntimeView,
} from './diagnostics';
import { isNotFoundError } from './result-review';

/** Page-scoped state for `/settings/diagnostics` (runtime, optional document provenance & JSON export). */
@Injectable()
export class DiagnosticsStore {
  private readonly route = inject(ActivatedRoute);
  private readonly library = inject(DesktopLibraryService);
  private readonly formatting = inject(DesktopWorkspaceFormattingService);
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly workspace = inject(DesktopWorkspaceStore);

  private readonly queryParamMap = toSignal(this.route.queryParamMap);

  readonly documentId = computed(() => {
    const value = this.queryParamMap()?.get('document')?.trim() ?? '';
    return value === '' ? null : value;
  });

  private readonly detailResource = rxResource<
    DesktopLibraryDetail | null,
    { readonly documentId: string } | undefined
  >({
    defaultValue: null,
    params: () => {
      const documentId = this.documentId();
      return documentId ? { documentId } : undefined;
    },
    stream: ({ params, abortSignal }) =>
      this.library.get(params.documentId, abortSignal),
  });

  readonly runtimeView = computed(() =>
    buildDiagnosticsRuntimeView({
      state: this.workspace.state(),
      workspaceMessage: this.workspace.message(),
      runtimeStatus: this.runtime.status(),
      ocrCompute: this.runtime.ocrCompute(),
      messages: desktopMessages(),
    }),
  );

  readonly documentLoading = computed(
    () =>
      this.documentId() !== null &&
      (this.detailResource.status() === 'loading' ||
        this.detailResource.status() === 'reloading'),
  );

  readonly notFound = computed(() => {
    const error = this.detailResource.error();
    return error ? isNotFoundError(error) : false;
  });

  readonly documentError = computed(() => {
    const error = this.detailResource.error();
    if (!error || isNotFoundError(error)) return null;
    return desktopMessages().diagnosticsDocumentLoadError;
  });

  readonly document = computed(() => {
    if (this.documentId() === null || this.detailResource.error()) return null;
    const detail = this.detailResource.hasValue()
      ? this.detailResource.value()
      : null;
    return detail ? buildDiagnosticsDocumentView(detail) : null;
  });

  readonly exporting = signal(false);
  readonly exportError = signal<string | null>(null);

  private readonly clearExportErrorOnDocumentChange = effect(() => {
    this.documentId();
    this.exportError.set(null);
  });

  reconnect(): void {
    this.workspace.initialize();
  }

  exportJson(): void {
    const doc = this.document();
    if (!doc || !doc.canExportJson || this.exporting()) return;
    this.exportError.set(null);
    this.exporting.set(true);
    this.library
      .export(doc.documentId, 'json')
      .pipe(finalize(() => this.exporting.set(false)))
      .subscribe({
        next: (exported) => {
          this.formatting.downloadText(
            exported.fileName,
            exported.content,
            exported.mediaType,
          );
        },
        error: () => {
          this.exportError.set(desktopMessages().diagnosticsExportFailed);
        },
      });
  }
}
