import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
} from '@angular/core';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { desktopMessages } from '../i18n/desktop-messages';
import { ResultReviewStore } from '../services/result-review.store';

@Component({
  selector: 'app-result-speakers-page',
  templateUrl: './result-speakers-page.html',
  imports: [HlmCardImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultSpeakersPage {
  protected readonly store = inject(ResultReviewStore);
  protected readonly m = desktopMessages;

  /** Enter that confirms an input-method candidate is not a commit. */
  protected nameOnEnter(event: Event, speakerId: string, name: string): void {
    if ((event as KeyboardEvent).isComposing) return;
    this.store.nameSpeaker(speakerId, name);
  }

  constructor() {
    effect(() => {
      if (this.store.hasResult()) {
        this.store.loadSource();
      }
    });
  }
}
