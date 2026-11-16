import { computed, Injectable, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import type { DesktopComputeStatus } from '../contracts';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceCaptureService } from './desktop-workspace-capture.service';
import { errorMessage } from './desktop-workspace.selectors';
import { RecognitionFeaturesStore } from './recognition-features.store';

@Injectable({ providedIn: 'root' })
/** Compute device status for OCR and speech GPU preference. */
export class ComputeSettingsStore {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly features = inject(RecognitionFeaturesStore);
  private readonly captureLifecycle = inject(DesktopWorkspaceCaptureService);

  readonly ocrCompute = this.runtime.ocrCompute;
  readonly savingCompute = signal(false);
  readonly error = signal<string | null>(null);

  private readonly computeResource = rxResource<DesktopComputeStatus, undefined>(
    {
      stream: ({ abortSignal }) => this.runtime.getComputeStatus(abortSignal),
    },
  );

  readonly speechStatus = computed<DesktopComputeStatus | null>(() =>
    this.computeResource.hasValue() ? this.computeResource.value() : null,
  );

  /** The GPU setting for speech recognition, offered only when a CUDA driver is present. */
  readonly speechGpu = computed<DesktopComputeStatus | null>(() => {
    const status = this.speechStatus();
    return status?.cudaAvailable ? status : null;
  });

  /** Changing it relaunches the runtime, which would stop a capture or installation. */
  readonly canChangeCompute = computed(
    () =>
      !this.savingCompute() &&
      !this.features.installing() &&
      this.captureLifecycle.busyIds().size === 0,
  );

  reload(): void {
    this.computeResource.reload();
  }

  /** Lets speech recognition use the GPU or not, then waits for the relaunched runtime. */
  setPreferGpu(preferGpu: boolean): void {
    if (!this.canChangeCompute() || this.speechGpu()?.preferGpu === preferGpu) {
      return;
    }
    this.error.set(null);
    this.savingCompute.set(true);
    this.runtime
      .setPreferGpu(preferGpu)
      .pipe(finalize(() => this.savingCompute.set(false)))
      .subscribe({
        next: () => {
          this.runtime.reload();
          this.computeResource.reload();
          this.features.initialize();
        },
        error: (error: unknown) => {
          this.computeResource.reload();
          this.error.set(errorMessage(error));
        },
      });
  }
}
