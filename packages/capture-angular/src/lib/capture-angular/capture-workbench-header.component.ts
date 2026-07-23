import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CaptureWorkbenchStore } from './capture-workbench-store';

@Component({
  selector: 'gx-capture-workbench-header',
  template: `
    <header class="workbench-heading">
      <div>
        <p class="eyebrow">
          {{ store.config().labels?.eyebrow ?? 'PDF · Image · Audio' }}
        </p>
        <h2>{{ store.config().labels?.title ?? 'Capture workbench' }}</h2>
        <p class="muted">
          {{ store.resolvedConfig().structuringMode === 'host'
            ? 'Raw extraction uses Capture Runtime; structuring uses the host provider.'
            : 'Extraction and isolated structuring use Capture Runtime.' }}
        </p>
      </div>
      <label class="file-picker">
        {{ store.config().labels?.chooseFiles ?? 'Choose files' }}
        <input
          type="file"
          [accept]="store.accept()"
          [multiple]="store.resolvedConfig().multiple"
          [disabled]="store.captureDisabled()"
          (change)="chooseFiles($event)"
        />
      </label>
    </header>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureWorkbenchHeaderComponent {
  protected readonly store = inject(CaptureWorkbenchStore);

  protected chooseFiles(event: Event): void {
    this.store.chooseFiles(event);
  }
}
