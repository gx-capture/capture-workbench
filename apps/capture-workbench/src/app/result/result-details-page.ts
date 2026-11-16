import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { desktopMessages } from '../i18n/desktop-messages';
import { ResultReviewStore } from '../services/result-review.store';

@Component({
  selector: 'app-result-details-page',
  templateUrl: './result-details-page.html',
  imports: [HlmCardImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultDetailsPage {
  protected readonly store = inject(ResultReviewStore);
  protected readonly m = desktopMessages;
}
