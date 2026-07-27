import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import {
  CaptureWorkbenchComponent,
  type CaptureCompletedEvent,
  type CaptureFailedEvent,
  type CaptureStructuringMode,
} from '@gx/capture-workbench';
import { ValidationCaptureClientService } from './services/validation-client.service';
import { CaptureWorkbenchUiState } from './services/capture-workbench-ui-state.service';

@Component({
  imports: [CaptureWorkbenchComponent],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly validationClient = inject(ValidationCaptureClientService);
  private readonly uiState = inject(CaptureWorkbenchUiState);
  protected readonly hostStructuringAvailable =
    this.uiState.hostStructuringAvailable;
  protected readonly structuringMode = this.uiState.structuringMode;
  protected readonly lastEvent = signal('No capture submitted yet.');
  protected readonly clientMode = this.validationClient.mode;

  protected selectMode(mode: CaptureStructuringMode): void {
    this.uiState.selectMode(mode);
  }

  protected recordCompletion(event: CaptureCompletedEvent): void {
    this.lastEvent.set(`Completed ${event.document.source.fileName}`);
  }

  protected recordFailure(event: CaptureFailedEvent): void {
    this.lastEvent.set(`Failed ${event.fileName}: ${event.error.code}`);
  }
}
