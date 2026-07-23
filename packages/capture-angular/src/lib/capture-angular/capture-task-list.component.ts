import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CaptureTaskItemComponent } from './capture-task-item.component';
import { CaptureWorkbenchStore } from './capture-workbench-store';

@Component({
  selector: 'gx-capture-task-list',
  imports: [CaptureTaskItemComponent],
  template: `
    @if (store.tasks().length === 0) {
      <div class="empty-state">
        {{ store.config().labels?.emptyState ?? 'Add a PDF, image, or audio recording.' }}
      </div>
    } @else {
      <ol class="task-list" aria-label="Capture tasks">
        @for (task of store.tasks(); track task.id) {
          <gx-capture-task-item [task]="task" />
        }
      </ol>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureTaskListComponent {
  protected readonly store = inject(CaptureWorkbenchStore);
}
