import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import type {
  CaptureRequirementId,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { desktopMessages } from '../i18n/desktop-messages';
import { PlaceholderPage } from '../placeholder/placeholder-page';
import {
  formatApproximateBytes,
  installationPercent,
} from '../services/desktop-workspace.selectors';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';

@Component({
  selector: 'app-ocr-page',
  templateUrl: './ocr-page.html',
  imports: [HlmButtonImports, HlmCardImports, PlaceholderPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcrPage {
  protected readonly features = inject(RecognitionFeaturesStore);
  protected readonly m = desktopMessages;

  private readonly manualSelection = signal<ReadonlySet<CaptureRequirementId> | null>(
    null,
  );

  protected readonly ocrUnit = computed(() =>
    this.findInstallable('windowsml-ocr'),
  );
  protected readonly asrUnit = computed(() =>
    this.findInstallable('speech-recognition'),
  );
  protected readonly speakersUnit = computed(() =>
    this.findInstallable('speaker-diarization'),
  );

  protected readonly selectedIds = computed<readonly CaptureRequirementId[]>(() => {
    const available = new Set(
      this.features.firstRunInstallableUnits().map((u) => u.requirementId),
    );
    const manual = this.manualSelection();
    if (manual === null) {
      return available.has('windowsml-ocr') ? ['windowsml-ocr'] : [];
    }
    return [...manual].filter((id) => available.has(id));
  });

  protected readonly selectedSizeLabel = computed(() => {
    const ids = new Set(this.selectedIds());
    const units = this.features
      .firstRunInstallableUnits()
      .filter((u) => ids.has(u.requirementId));
    const totalBytes = units.reduce(
      (sum, unit) =>
        typeof unit.downloadBytes === 'number' && unit.downloadBytes > 0
          ? sum + unit.downloadBytes
          : sum,
      0,
    );
    return formatApproximateBytes(totalBytes > 0 ? totalBytes : null);
  });

  protected readonly activeRunningInstallation = computed(() => {
    const active = this.features.activeInstallation();
    if (!active) return null;
    return active.status === 'queued' || active.status === 'running'
      ? active
      : null;
  });

  protected readonly activePercent = computed(() =>
    installationPercent(this.activeRunningInstallation()),
  );

  protected isSelected(requirementId: CaptureRequirementId): boolean {
    return this.selectedIds().includes(requirementId);
  }

  protected toggleUnit(
    requirementId: CaptureRequirementId,
    checked: boolean,
  ): void {
    const next = new Set(this.selectedIds());
    if (checked) {
      next.add(requirementId);
      if (
        requirementId === 'speaker-diarization' &&
        this.asrUnit() !== null
      ) {
        next.add('speech-recognition');
      }
    } else {
      next.delete(requirementId);
      if (requirementId === 'speech-recognition') {
        next.delete('speaker-diarization');
      }
    }
    this.manualSelection.set(next);
  }

  protected sizeFor(requirement: RuntimeRequirement | null): string | null {
    return formatApproximateBytes(requirement?.downloadBytes);
  }

  protected installSelected(): void {
    this.features.installFirstRunSelection(this.selectedIds());
  }

  protected dismiss(): void {
    this.features.dismissFirstRun();
  }

  private findInstallable(
    requirementId: CaptureRequirementId,
  ): RuntimeRequirement | null {
    return (
      this.features
        .firstRunInstallableUnits()
        .find((unit) => unit.requirementId === requirementId) ?? null
    );
  }
}
