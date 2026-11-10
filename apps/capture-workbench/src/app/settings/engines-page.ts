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
import { BrnAlertDialogImports } from '@spartan-ng/brain/alert-dialog';
import { BrnDialogClose } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { desktopLocale, desktopMessages } from '../i18n/desktop-messages';
import {
  captureNeedsRequirement,
  formatApproximateBytes,
  installationPercent,
} from '../services/desktop-workspace.selectors';
import { DesktopWorkspaceStore } from '../services/desktop-workspace.store';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';

@Component({
  selector: 'app-engines-page',
  templateUrl: './engines-page.html',
  imports: [
    HlmButtonImports,
    HlmCardImports,
    HlmTableImports,
    BrnAlertDialogImports,
    BrnDialogClose,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnginesPage {
  protected readonly features = inject(RecognitionFeaturesStore);
  private readonly workspace = inject(DesktopWorkspaceStore);
  protected readonly m = desktopMessages;
  private readonly locale = desktopLocale;
  protected readonly removeTarget = signal<RuntimeRequirement | null>(null);
  protected readonly removeDialogState = computed(() =>
    this.removeTarget() === null ? 'closed' : 'open',
  );

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

  protected engineName(unit: RuntimeRequirement): string {
    return this.m().engineName[unit.requirementId] ?? unit.displayName;
  }

  protected removing(unit: RuntimeRequirement): boolean {
    return this.features.isRemoving(unit.requirementId);
  }

  protected removalFailure(unit: RuntimeRequirement): string | null {
    return this.features.removalError(unit.requirementId);
  }

  protected removalBlock(
    unit: RuntimeRequirement,
  ): 'installing' | 'capture' | null {
    if (this.isRunning(unit)) return 'installing';
    if (
      captureNeedsRequirement(
        unit.requirementId,
        this.workspace.allDocuments(),
      )
    ) {
      return 'capture';
    }
    return null;
  }

  protected askRemove(unit: RuntimeRequirement): void {
    if (this.removing(unit)) return;
    if (this.removalBlock(unit) !== null) return;
    this.removeTarget.set(unit);
  }

  protected confirmRemove(): void {
    const target = this.removeTarget();
    if (!target) return;
    this.features.removeUnit(target.requirementId);
    this.removeTarget.set(null);
  }

  protected onRemoveDialogState(state: 'open' | 'closed'): void {
    if (state === 'closed') this.removeTarget.set(null);
  }

  protected removeTitle(unit: RuntimeRequirement): string {
    return this.m().removeEngineTitle(this.engineName(unit));
  }

  protected removeBody(unit: RuntimeRequirement): string {
    return this.m().removeEngineBody(this.engineName(unit), this.sizeLabel(unit));
  }
}
