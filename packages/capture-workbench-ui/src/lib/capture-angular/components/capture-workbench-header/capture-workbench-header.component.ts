import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CaptureWorkbenchStore } from '../../services/capture-workbench-store/capture-workbench-store';

@Component({
  selector: 'gx-capture-workbench-header',
  template: `
    <header class="workbench-heading">
      <div>
        @if (m().eyebrow; as eyebrow) {
          <p class="eyebrow">{{ eyebrow }}</p>
        }
        <h2>{{ m().title }}</h2>
      </div>
      <label class="file-picker">
        {{ m().chooseFiles }}
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
  protected readonly m = this.store.messages;

  protected chooseFiles(event: Event): void {
    this.store.chooseFiles(event);
  }
}
