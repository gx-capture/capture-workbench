import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  CAPTURE_UNIT_GUIDES,
  type CaptureRequirementId,
  type RuntimeInstallation,
  type RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { desktopLocale, desktopMessages } from '../i18n/desktop-messages';
import { formatApproximateBytes } from '../services/desktop-workspace.selectors';
import { InstallProgress } from './install-progress';

/**
 * Displays one recognition engine unit: its model guide facts from
 * `CAPTURE_UNIT_GUIDES`, formatted download size from the runtime requirement,
 * explicit install consent button with size, byte-based progress with cancel,
 * and retry after failure.
 */
@Component({
  selector: 'app-engine-card',
  templateUrl: './engine-card.html',
  imports: [HlmButtonImports, HlmCardImports, InstallProgress],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EngineCard {
  readonly requirement = input.required<RuntimeRequirement>();
  readonly installation = input<RuntimeInstallation | null>(null);
  readonly installing = input(false);
  /** The start request for this unit is in flight: progress shows with the click. */
  readonly starting = input(false);
  readonly optional = input(false);

  readonly install = output<CaptureRequirementId>();
  readonly cancelInstall = output<string>();
  readonly retry = output<CaptureRequirementId>();

  protected readonly m = desktopMessages;
  private readonly locale = desktopLocale;

  protected readonly guide = computed(
    () => CAPTURE_UNIT_GUIDES[this.locale()][this.requirement().requirementId],
  );
  protected readonly sizeLabel = computed(() =>
    formatApproximateBytes(this.requirement().downloadBytes),
  );
  protected readonly installLabel = computed(() =>
    this.m().installWithSize(this.sizeLabel()),
  );
  protected readonly isRunning = computed(() => {
    const status = this.installation()?.status;
    return status === 'queued' || status === 'running';
  });
  /** The installation whose progress is shown; none yet while the start request is in flight. */
  protected readonly runningInstallation = computed(() =>
    this.isRunning() ? this.installation() : null,
  );
  protected readonly showsProgress = computed(
    () => this.isRunning() || this.starting(),
  );
  protected readonly isFailed = computed(() => {
    const status = this.installation()?.status;
    return (
      (status === 'failed' || status === 'cancelled') &&
      this.requirement().status !== 'ready'
    );
  });
}
