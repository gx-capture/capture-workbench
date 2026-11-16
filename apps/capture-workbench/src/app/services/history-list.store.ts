import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { finalize, timer } from 'rxjs';
import { desktopMessages } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopWorkspaceCaptureService } from './desktop-workspace-capture.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
import { filterHistoryRows, historyRow, type HistoryFilters, type HistoryRow } from './history-list';

@Injectable({ providedIn: 'root' })
export class HistoryListStore {
  private readonly workspace = inject(DesktopWorkspaceStore);
  private readonly capture = inject(DesktopWorkspaceCaptureService);
  private readonly library = inject(DesktopLibraryService);
  private readonly router = inject(Router);
  private readonly formatting = inject(DesktopWorkspaceFormattingService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  readonly typeFilter = signal<HistoryFilters['type']>('all');
  readonly statusFilter = signal<HistoryFilters['status']>('all');
  readonly search = signal('');
  readonly error = signal('');
  readonly deleting = signal(false);
  readonly pendingDelete = signal<HistoryRow | null>(null);
  readonly dialogState = computed(() => this.pendingDelete() ? 'open' : 'closed');
  readonly hasDocuments = computed(() => (this.workspace.allDocuments() ?? []).length > 0);
  private readonly allRows = computed(() => (this.workspace.allDocuments() ?? []).map((document) => historyRow(
    document,
    this.capture.busyIds().has(document.documentId),
    this.capture.jobs().get(document.documentId) ?? this.capture.streamingOperations().get(document.documentId),
    this.capture.hasActiveCapture(document.documentId),
  )));
  readonly rows = computed(() => filterHistoryRows(this.allRows(), {
    type: this.typeFilter(), status: this.statusFilter(), search: this.search(),
  }).map((row) => ({ ...row, updatedAt: this.formatting.formatDate(row.updatedAtMs) })));

  open(documentId: string): void {
    void this.router.navigate(['/history', documentId], { queryParams: { from: 'history' } });
  }

  askDelete(row: HistoryRow): void {
    if (this.deleting() || !this.canDelete(row.documentId)) return;
    this.error.set('');
    this.pendingDelete.set(row);
  }

  cancelDelete(): void {
    if (this.deleting()) return;
    this.pendingDelete.set(null);
    this.restoreFocus();
  }

  onDialogState(state: 'open' | 'closed'): void {
    if (state === 'closed') this.cancelDelete();
  }

  confirmDelete(): void {
    const pending = this.pendingDelete();
    if (!pending || this.deleting()) return;
    if (!this.canDelete(pending.documentId)) {
      this.cancelDelete();
      return;
    }
    this.deleting.set(true);
    this.library.delete(pending.documentId).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.deleting.set(false)),
    ).subscribe({
      next: () => {
        this.workspace.refreshDocuments();
        this.pendingDelete.set(null);
        this.restoreFocus();
      },
      error: () => {
        this.error.set(desktopMessages().historyDeleteFailed);
        this.pendingDelete.set(null);
        this.restoreFocus();
      },
    });
  }

  private canDelete(documentId: string): boolean {
    const document = (this.workspace.allDocuments() ?? []).find((item) => item.documentId === documentId);
    return document !== undefined && !document.captureId
      && !this.capture.busyIds().has(documentId)
      && !this.capture.hasActiveCapture(documentId);
  }

  private restoreFocus(): void {
    timer(0).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.document.querySelector<HTMLElement>('[data-testid="history-search"]')?.focus();
    });
  }
}
