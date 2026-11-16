import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { desktopMessages } from '../i18n/desktop-messages';
import { ResultReviewStore } from '../services/result-review.store';

@Component({
  selector: 'app-result-page',
  templateUrl: './result-page.html',
  providers: [ResultReviewStore],
  imports: [HlmButtonImports, RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultPage {
  protected readonly store = inject(ResultReviewStore);
  protected readonly m = desktopMessages;
}
