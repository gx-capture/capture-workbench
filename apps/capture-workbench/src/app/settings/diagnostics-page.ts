import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { desktopMessages } from '../i18n/desktop-messages';
import { formatApproximateBytes } from '../services/desktop-workspace.selectors';
import { DiagnosticsStore } from '../services/diagnostics.store';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';

@Component({
  selector: 'app-diagnostics-page',
  templateUrl: './diagnostics-page.html',
  providers: [DiagnosticsStore],
  imports: [HlmButtonImports, HlmCardImports, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiagnosticsPage {
  protected readonly store = inject(DiagnosticsStore);
  protected readonly features = inject(RecognitionFeaturesStore);
  protected readonly m = desktopMessages;

  protected modelSizeLabel(expectedBytes: number | null | undefined): string | null {
    return formatApproximateBytes(expectedBytes);
  }
}
