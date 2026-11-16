import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { desktopMessages } from '../i18n/desktop-messages';
import { ResultReviewStore } from '../services/result-review.store';

@Component({
  selector: 'app-result-content-page',
  templateUrl: './result-content-page.html',
  imports: [HlmButtonImports, HlmCardImports, HlmTableImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultContentPage {
  protected readonly store = inject(ResultReviewStore);
  protected readonly m = desktopMessages;
  private readonly mediaPlayer = viewChild<ElementRef<HTMLMediaElement>>('mediaPlayer');
  private readonly pdfCanvas = viewChild<ElementRef<HTMLCanvasElement>>('pdfCanvas');
  private readonly sourcePane = viewChild<ElementRef<HTMLElement>>('sourcePane');
  private readonly lineInput = viewChild<ElementRef<HTMLTextAreaElement>>('lineInput');

  protected readonly editingLine = signal<string | null>(null);
  protected readonly lineDraft = signal('');
  private readonly previewPage = computed(() => this.store.currentPage()?.page);

  protected beginLine(segmentId: string, text: string): void {
    this.editingLine.set(segmentId);
    this.lineDraft.set(text);
  }

  /** Enter that confirms an input-method candidate is not a commit. */
  protected commitLineOnEnter(event: Event, segmentId: string): void {
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    this.commitLine(segmentId);
  }

  protected commitLine(segmentId: string): void {
    if (this.editingLine() !== segmentId) return;
    this.store.editLine(segmentId, this.lineDraft());
    this.editingLine.set(null);
  }

  constructor() {
    effect(() => {
      if (this.store.hasResult()) {
        this.store.loadSource();
      }
    });

    effect(() => {
      if (!this.store.isPdf()) return;
      const page = this.previewPage();
      const state = this.store.pdfState();
      const canvas = this.pdfCanvas()?.nativeElement;
      const container = this.sourcePane()?.nativeElement;
      if (!page || !canvas || !container || state !== 'ready') return;
      untracked(() => {
        this.store.renderCurrentPdfPage(canvas, container.clientWidth);
      });
    });

    effect(() => {
      const seek = this.store.activeSeek();
      const player = this.mediaPlayer()?.nativeElement;
      if (!seek || !player) return;
      player.currentTime = seek.ms / 1000;
      void player.play()?.catch(() => undefined);
    });

    effect(() => {
      const input = this.lineInput()?.nativeElement;
      if (input) input.focus();
    });
  }
}
