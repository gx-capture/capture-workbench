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
} from '../../../contracts';
import { CaptureTaskListComponent } from '../capture-task-list/capture-task-list.component';
import { CaptureRuntimeSetupComponent } from '../capture-runtime-setup/capture-runtime-setup.component';
import { CaptureWorkbenchHeaderComponent } from '../capture-workbench-header/capture-workbench-header.component';
import { CaptureRuntimeInstallationService } from '../../services/capture-runtime-installation/capture-runtime-installation.service';
import { CaptureWorkflowService } from '../../services/capture-workflow/capture-workflow.service';
import { CaptureReconciliationService } from '../../services/capture-reconciliation/capture-reconciliation.service';
import { CaptureWorkbenchStore } from '../../services/capture-workbench-store/capture-workbench-store';

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
  encapsulation: ViewEncapsulation.ShadowDom,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureWorkbenchComponent {
  readonly completed = output<CaptureCompletedEvent>();
  readonly reviewRequired = output<CaptureTaskView>();
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
        case 'review-required':
          this.reviewRequired.emit(event.task);
          break;
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
