import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { OcrComputePreflight } from '../../../contracts';
import {
  CAPTURE_WORKBENCH_MESSAGES,
  DEFAULT_CAPTURE_WORKBENCH_LOCALE,
} from '../../i18n/messages';

@Component({
  selector: 'gx-capture-runtime-compute-status',
  template: `
    @if (preflight(); as compute) {
      @if (
        compute.mode === 'cpu-fallback' &&
        compute.userNoticeRequired &&
        compute.noticeCode === 'ocr_cpu_fallback'
      ) {
        <p
          class="runtime-compute-notice"
          data-testid="ocr-compute-notice"
          data-mode="cpu-fallback"
          role="status"
        >
          {{ cpuNotice() ?? defaults.cpuNotice }}
        </p>
      } @else if (compute.mode === 'gpu-dml') {
        <p
          class="runtime-compute-status"
          data-testid="ocr-compute-status"
          data-mode="gpu-dml"
          role="status"
        >
          {{ gpuLabel() ?? defaults.gpuAcceleration }}
        </p>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureRuntimeComputeStatusComponent {
  readonly preflight = input<OcrComputePreflight | null>();
  /** Shown while OCR runs on the GPU. */
  readonly gpuLabel = input<string>();
  /** Shown when OCR falls back to the CPU and the runtime asks for a notice. */
  readonly cpuNotice = input<string>();
  protected readonly defaults =
    CAPTURE_WORKBENCH_MESSAGES[DEFAULT_CAPTURE_WORKBENCH_LOCALE];
}
