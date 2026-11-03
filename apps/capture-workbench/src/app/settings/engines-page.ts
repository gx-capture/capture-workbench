import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  CAPTURE_UNIT_GUIDES,
  type CaptureRequirementId,
  type RuntimeInstallation,
  type RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { desktopLocale, desktopMessages } from '../i18n/desktop-messages';
import {
  formatApproximateBytes,
  installationPercent,
} from '../services/desktop-workspace.selectors';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';

@Component({
  selector: 'app-engines-page',
  templateUrl: './engines-page.html',
  imports: [HlmButtonImports, HlmCardImports, HlmTableImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnginesPage {
  protected readonly features = inject(RecognitionFeaturesStore);
  protected readonly m = desktopMessages;
  private readonly locale = desktopLocale;

  protected readonly expandedIds = signal<ReadonlySet<CaptureRequirementId>>(
    new Set(),
  );
  protected readonly guides = computed(
    () => CAPTURE_UNIT_GUIDES[this.locale()],
  );

  protected isExpanded(requirementId: CaptureRequirementId): boolean {
    return this.expandedIds().has(requirementId);
  }

  protected toggleExpand(requirementId: CaptureRequirementId): void {
    this.expandedIds.update((current) => {
      const next = new Set(current);
      if (next.has(requirementId)) {
        next.delete(requirementId);
      } else {
        next.add(requirementId);
      }
      return next;
    });
  }

  protected installationFor(
    unit: RuntimeRequirement,
  ): RuntimeInstallation | null {
    return this.features.installationFor(unit.requirementId);
  }

  protected isRunning(unit: RuntimeRequirement): boolean {
    const status = this.installationFor(unit)?.status;
    return status === 'queued' || status === 'running';
  }

  protected isFailed(unit: RuntimeRequirement): boolean {
    const status = this.installationFor(unit)?.status;
    return (
      (status === 'failed' || status === 'cancelled') &&
      unit.status !== 'ready'
    );
  }

  protected rowStatus(unit: RuntimeRequirement): string {
    const installation = this.installationFor(unit);
    if (
      installation &&
      (installation.status === 'queued' ||
        installation.status === 'running' ||
        (unit.status !== 'ready' &&
          (installation.status === 'failed' ||
            installation.status === 'cancelled')))
    ) {
      return installation.status;
    }
    return unit.status;
  }

  protected statusLabel(unit: RuntimeRequirement): string {
    const status = this.rowStatus(unit);
    return this.m().engineStatus[status] ?? status;
  }

  protected sizeLabel(unit: RuntimeRequirement): string | null {
    return formatApproximateBytes(unit.downloadBytes);
  }

  protected installLabel(unit: RuntimeRequirement): string {
    return this.m().installWithSize(this.sizeLabel(unit));
  }

  protected percentFor(unit: RuntimeRequirement): number {
    return installationPercent(this.installationFor(unit));
  }
}
