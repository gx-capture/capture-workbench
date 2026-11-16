import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  effect,
  inject,
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

  constructor() {
    effect(() => {
      if (this.store.hasResult()) {
        this.store.loadSource();
      }
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
