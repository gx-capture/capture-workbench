import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  effect,
  inject,
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

  constructor() {
    effect(() => {
      if (this.store.hasResult()) {
        this.store.loadSource();
      }
    });

    effect(() => {
      if (!this.store.isPdf()) return;
      const page = this.store.currentPage();
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
  }
}
