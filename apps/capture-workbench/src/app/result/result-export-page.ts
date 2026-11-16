import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { desktopMessages } from '../i18n/desktop-messages';
import { ResultExportStore } from '../services/result-export.store';

@Component({
  selector: 'app-result-export-page',
  templateUrl: './result-export-page.html',
  imports: [HlmButtonImports],
  providers: [ResultExportStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultExportPage {
  protected readonly store = inject(ResultExportStore);
  protected readonly m = desktopMessages;
}
