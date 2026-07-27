import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  CaptureStructuringMode,
  CaptureWorkbenchConfig,
} from '@gx-capture/capture-workbench';
import { ValidationCaptureClientService } from './validation-client.service';

@Injectable({ providedIn: 'root' })
export class CaptureWorkbenchUiState {
  private readonly validationClient = inject(ValidationCaptureClientService);
  private readonly requestedStructuringMode =
    signal<CaptureStructuringMode>('runtime');

  readonly hostStructuringAvailable =
    this.validationClient.hostStructuringAvailable;
  readonly structuringMode = computed<CaptureStructuringMode>(() =>
    this.hostStructuringAvailable && this.requestedStructuringMode() === 'host'
      ? 'host'
      : 'runtime',
  );
  readonly config = computed<CaptureWorkbenchConfig>(() => ({
    structuringMode: this.structuringMode(),
    outputMode: 'json',
    pollIntervalMs: 0,
    labels: {
      title: 'Validation capture queue',
      emptyState:
        'Choose a fixture PDF, image, or audio file to run the packaged workflow.',
    },
    theme: {
      accent: this.structuringMode() === 'runtime' ? '#4f46e5' : '#0f766e',
    },
  }));

  selectMode(mode: CaptureStructuringMode): void {
    if (mode === 'host' && !this.hostStructuringAvailable) return;
    this.requestedStructuringMode.set(mode);
  }
}
