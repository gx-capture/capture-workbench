import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import {
  CaptureWorkbenchComponent,
  type CaptureCompletedEvent,
  type CaptureFailedEvent,
  type CaptureStructuringMode,
} from '@gx/capture-angular';
import { validationCaptureClient } from './validation-client';

@Component({
  imports: [CaptureWorkbenchComponent],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly requestedStructuringMode = signal<CaptureStructuringMode>('runtime');
  protected readonly hostStructuringAvailable =
    validationCaptureClient.hostStructuringAvailable;
  protected readonly structuringMode = computed<CaptureStructuringMode>(() =>
    this.hostStructuringAvailable && this.requestedStructuringMode() === 'host'
      ? 'host'
      : 'runtime',
  );
  protected readonly config = computed(() => ({
    structuringMode: this.structuringMode(),
    outputMode: 'json' as const,
    pollIntervalMs: 0,
    labels: {
      title: 'Validation capture queue',
      emptyState: 'Choose a fixture PDF, image, or audio file to run the packaged workflow.',
    },
    theme: { accent: this.structuringMode() === 'runtime' ? '#4f46e5' : '#0f766e' },
  }));
  protected readonly lastEvent = signal('No capture submitted yet.');
  protected readonly clientMode = validationCaptureClient.mode;

  protected selectMode(mode: CaptureStructuringMode): void {
    if (mode === 'host' && !this.hostStructuringAvailable) return;
    this.requestedStructuringMode.set(mode);
  }

  protected recordCompletion(event: CaptureCompletedEvent): void {
    this.lastEvent.set(`Completed ${event.document.source.fileName}`);
  }

  protected recordFailure(event: CaptureFailedEvent): void {
    this.lastEvent.set(`Failed ${event.fileName}: ${event.error.code}`);
  }
}
