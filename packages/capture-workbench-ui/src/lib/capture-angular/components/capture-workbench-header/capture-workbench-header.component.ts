import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CaptureWorkbenchStore } from '../../services/capture-workbench-store/capture-workbench-store';

@Component({
  selector: 'gx-capture-workbench-header',
  template: `
    <header class="workbench-heading">
      <div>
        @if (store.config().labels?.eyebrow; as eyebrow) {
          <p class="eyebrow">{{ eyebrow }}</p>
        }
        <h2>{{ store.config().labels?.title ?? 'Capture workbench' }}</h2>
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
