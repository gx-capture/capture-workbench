import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CaptureRuntimeComputeStatusComponent } from '@gx-capture/capture-workbench-ui';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { desktopMessages } from '../i18n/desktop-messages';
import { ComputeSettingsStore } from '../services/compute-settings.store';

@Component({
  selector: 'app-compute-page',
  templateUrl: './compute-page.html',
  imports: [CaptureRuntimeComputeStatusComponent, HlmCardImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComputePage {
  protected readonly compute = inject(ComputeSettingsStore);
  protected readonly m = desktopMessages;

  protected onPreferGpuChange(event: Event): void {
    this.compute.setPreferGpu((event.target as HTMLInputElement).checked);
  }
}
