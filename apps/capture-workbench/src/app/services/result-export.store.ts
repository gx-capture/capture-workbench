import { computed, DestroyRef, effect, Injectable, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { desktopMessages } from '../i18n/desktop-messages';
import { LibraryExportService } from './library-export.service';
import { ResultReviewStore } from './result-review.store';

@Injectable()
export class ResultExportStore {
  private readonly review = inject(ResultReviewStore);
  private readonly exports = inject(LibraryExportService);
  private readonly destroyRef = inject(DestroyRef);
  private runningExport: Subscription | null = null;
  private exportDocumentId = this.review.documentId();
  readonly status = signal<string | null>(null);
  readonly busy = computed(() => this.exports.busyIds().has(this.review.documentId() ?? ''));
  readonly disabled = computed(() => this.busy() || !this.review.hasResult());
  readonly formats = computed(() => {
    const m = desktopMessages();
    const isOcr = this.review.kind() === 'ocr';
    const text = {
      format: 'text' as const,
      label: m.exportPlainText,
      description: isOcr ? m.exportPlainTextDesc : m.exportRecordingPlainTextDesc,
    };
    const markdown = {
      format: 'markdown' as const,
      label: m.exportMarkdown,
      description: m.exportMarkdownDesc,
    };
    return isOcr
      ? [text, markdown]
      : [
          text,
          { format: 'srt' as const, label: m.exportSrt, description: m.exportSrtDesc },
          { format: 'vtt' as const, label: m.exportVtt, description: m.exportVttDesc },
          markdown,
        ];
  });

  private readonly documentChange = effect(() => {
    const id = this.review.documentId();
    untracked(() => {
      if (id === this.exportDocumentId) return;
      this.runningExport?.unsubscribe();
      this.runningExport = null;
      this.exportDocumentId = id;
      this.status.set(null);
    });
  });

  download(format: 'text' | 'markdown' | 'srt' | 'vtt'): void { this.run(format, false); }
  copy(): void { this.run('text', true); }

  private run(format: 'text' | 'markdown' | 'srt' | 'vtt', copy: boolean): void {
    const id = this.review.documentId();
    if (!id || this.disabled()) return;
    this.status.set(desktopMessages().exportInProgress);
    this.runningExport = this.exports.run(id, format, copy, this.review.saveBeforeExport())
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => this.status.set(copy ? desktopMessages().exportCopied : desktopMessages().exportDownloaded),
        error: () => this.status.set(this.review.saveError() ?? (copy ? desktopMessages().exportCopyFailed : desktopMessages().exportFailed)),
      });
  }
}
