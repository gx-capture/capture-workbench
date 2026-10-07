import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CaptureTaskItemComponent } from '../capture-task-item/capture-task-item.component';
import { CaptureWorkbenchStore } from '../../services/capture-workbench-store/capture-workbench-store';

@Component({
  selector: 'gx-capture-task-list',
  imports: [CaptureTaskItemComponent],
  template: `
    @if (store.tasks().length === 0) {
      <div class="empty-state">
        {{ m().emptyState }}
      </div>
    } @else {
      <ol class="task-list" [attr.aria-label]="m().captureTasks">
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
  protected readonly m = this.store.messages;
}
