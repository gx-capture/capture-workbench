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
import { InstallProgress } from '../engine-card/install-progress';
import { desktopLocale, desktopMessages } from '../i18n/desktop-messages';
import {
  captureNeedsRequirement,
  formatApproximateBytes,
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
    InstallProgress,
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
    requirement: RuntimeRequirement,
  ): RuntimeInstallation | null {
    return this.features.installationFor(requirement.requirementId);
  }

  /** The requirement's installation while it is queued or running; it can be cancelled. */
  protected runningInstallation(
    requirement: RuntimeRequirement,
  ): RuntimeInstallation | null {
    const installation = this.installationFor(requirement);
    return installation?.status === 'queued' || installation?.status === 'running'
      ? installation
      : null;
  }

  /** Also true while the start request is in flight, so progress shows with the click. */
  protected isRunning(requirement: RuntimeRequirement): boolean {
    return (
      this.runningInstallation(requirement) !== null ||
      this.features.startingRequirementId() === requirement.requirementId
    );
  }

  protected isFailed(requirement: RuntimeRequirement): boolean {
    const status = this.installationFor(requirement)?.status;
    return (
      (status === 'failed' || status === 'cancelled') &&
      requirement.status !== 'ready'
    );
  }

  protected rowStatus(requirement: RuntimeRequirement): string {
    const installation = this.installationFor(requirement);
    if (
      installation &&
      (installation.status === 'queued' ||
        installation.status === 'running' ||
        (requirement.status !== 'ready' &&
          (installation.status === 'failed' ||
            installation.status === 'cancelled')))
    ) {
      return installation.status;
    }
    return requirement.status;
  }

  protected statusLabel(requirement: RuntimeRequirement): string {
    const status = this.rowStatus(requirement);
    return this.m().requirementStatus[status] ?? status;
  }

  protected sizeLabel(requirement: RuntimeRequirement): string | null {
    return formatApproximateBytes(requirement.downloadBytes);
  }

  protected installLabel(requirement: RuntimeRequirement): string {
    return this.m().installWithSize(this.sizeLabel(requirement));
  }

  protected requirementName(requirement: RuntimeRequirement): string {
    return this.m().requirementName[requirement.requirementId] ?? requirement.displayName;
  }

  protected removing(requirement: RuntimeRequirement): boolean {
    return this.features.isRemoving(requirement.requirementId);
  }

  protected removalFailure(requirement: RuntimeRequirement): string | null {
    return this.features.removalError(requirement.requirementId);
  }

  protected removalBlock(
    requirement: RuntimeRequirement,
  ): 'installing' | 'capture' | null {
    if (this.isRunning(requirement)) return 'installing';
    if (
      captureNeedsRequirement(
        requirement.requirementId,
        this.workspace.allDocuments(),
      )
    ) {
      return 'capture';
    }
    return null;
  }

  protected askRemove(requirement: RuntimeRequirement): void {
    if (this.removing(requirement)) return;
    if (this.removalBlock(requirement) !== null) return;
    this.removeTarget.set(requirement);
  }

  protected confirmRemove(): void {
    const target = this.removeTarget();
    if (!target) return;
    this.features.removeRequirement(target.requirementId);
    this.removeTarget.set(null);
  }

  protected onRemoveDialogState(state: 'open' | 'closed'): void {
    if (state === 'closed') this.removeTarget.set(null);
  }

  protected removeTitle(requirement: RuntimeRequirement): string {
    return this.m().removeRequirementTitle(this.requirementName(requirement));
  }

  protected removeBody(requirement: RuntimeRequirement): string {
    return this.m().removeRequirementBody(this.requirementName(requirement), this.sizeLabel(requirement));
  }
}
