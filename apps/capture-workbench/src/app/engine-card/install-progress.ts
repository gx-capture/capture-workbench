import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { desktopMessages } from '../i18n/desktop-messages';
import {
  installationProgress,
  installationProgressLabel,
  type InstallationProgressSource,
} from '../services/installation-progress';

/**
 * The progress of one unit's installation: a line that says what is happening
 * and a bar. The bar shows the downloaded share while downloading and pulses
 * while there is no figure to show (before the download size is known, and
 * while the downloaded unit is being installed).
 */
@Component({
  selector: 'app-install-progress',
  templateUrl: './install-progress.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstallProgress {
  /** The running installation; `null` while its start request is in flight. */
  readonly installation = input<InstallationProgressSource | null>(null);

  protected readonly progress = computed(() =>
    installationProgress(this.installation()),
  );
  protected readonly label = computed(() =>
    installationProgressLabel(this.progress(), desktopMessages()),
  );
  protected readonly determinate = computed(
    () => this.progress().phase === 'downloading',
  );
  /** A short stub before the download starts, the full bar once it is done. */
  protected readonly fill = computed(() => {
    const progress = this.progress();
    if (progress.phase === 'preparing') return 0.08;
    if (progress.phase === 'installing') return 1;
    return progress.percent / 100;
  });
}
