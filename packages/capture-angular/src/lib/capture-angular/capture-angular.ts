import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  inject,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type CaptureCompletedEvent,
  type CaptureFailedEvent,
  type CaptureTaskView,
} from '../contracts';
import { CaptureTaskListComponent } from './capture-task-list.component';
import { CaptureRuntimeSetupComponent } from './capture-runtime-setup.component';
import { CaptureWorkbenchHeaderComponent } from './capture-workbench-header.component';
import { CaptureRuntimeInstallationService } from './capture-runtime-installation.service';
import { CaptureWorkflowService } from './capture-workflow.service';
import { CaptureReconciliationService } from './capture-reconciliation.service';
import { CaptureWorkbenchStore } from './capture-workbench-store';

@Component({
  selector: 'gx-capture-workbench',
  imports: [
    CaptureRuntimeSetupComponent,
    CaptureWorkbenchHeaderComponent,
    CaptureTaskListComponent,
  ],
  providers: [
    CaptureWorkbenchStore,
    CaptureRuntimeInstallationService,
    CaptureWorkflowService,
    CaptureReconciliationService,
  ],
  templateUrl: './capture-angular.html',
  styleUrl: './capture-angular.css',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureWorkbenchComponent {
  readonly completed = output<CaptureCompletedEvent>();
  readonly failed = output<CaptureFailedEvent>();
  readonly canceled = output<CaptureTaskView>();
  readonly taskChanged = output<CaptureTaskView>();

  readonly store = inject(CaptureWorkbenchStore);
  readonly tasks = this.store.tasks;
  readonly runtime = this.store.runtime;
  readonly installation = this.store.installation;

  private readonly eventSubscription = this.store.events
    .pipe(takeUntilDestroyed())
    .subscribe((event) => {
      switch (event.type) {
        case 'completed':
          this.completed.emit(event.event);
          break;
        case 'failed':
          this.failed.emit(event.event);
          break;
        case 'canceled':
          this.canceled.emit(event.task);
          break;
        case 'task-changed':
          this.taskChanged.emit(event.task);
          break;
      }
    });
}
