import { computed, DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { desktopMessages } from '../i18n/desktop-messages';
import { LibraryExportService } from './library-export.service';
import { ResultReviewStore } from './result-review.store';

@Injectable()
export class ResultExportStore {
  private readonly review = inject(ResultReviewStore);
  private readonly exports = inject(LibraryExportService);
  private readonly destroyRef = inject(DestroyRef);
  readonly status = signal<string | null>(null);
  readonly busy = computed(() => this.exports.busyIds().has(this.review.documentId() ?? ''));
  readonly disabled = computed(() => this.busy() || !this.review.hasResult());
  readonly formats = computed(() => {
    const m = desktopMessages();
    const text = { format: 'text' as const, label: m.exportPlainText };
    const markdown = { format: 'markdown' as const, label: m.exportMarkdown };
    return this.review.kind() === 'ocr' ? [text, markdown] : [text,
      { format: 'srt' as const, label: m.exportSrt },
      { format: 'vtt' as const, label: m.exportVtt }, markdown];
  });

  download(format: 'text' | 'markdown' | 'srt' | 'vtt'): void { this.run(format, false); }
  copy(): void { this.run('text', true); }

  private run(format: 'text' | 'markdown' | 'srt' | 'vtt', copy: boolean): void {
    const id = this.review.documentId();
    if (!id || this.disabled()) return;
    this.status.set(null);
    this.exports.run(id, format, copy, this.review.saveBeforeExport())
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => this.status.set(copy ? desktopMessages().exportCopied : desktopMessages().exportDownloaded),
        error: () => this.status.set(this.review.saveError() ?? (copy ? desktopMessages().exportCopyFailed : desktopMessages().exportFailed)),
      });
  }
}
