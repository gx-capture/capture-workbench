import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureFailedEvent,
  type CapturePreprocessor,
  type CaptureStructuringProvider,
  type CaptureTaskView,
  type CaptureWorkbenchConfig,
} from '../contracts';
import type { CaptureWorkbenchStoreOptions } from '../contracts/workbench';
import { CaptureTaskListComponent } from './capture-task-list.component';
import { CaptureRuntimeSetupComponent } from './capture-runtime-setup.component';
import { CaptureWorkbenchHeaderComponent } from './capture-workbench-header.component';
import { CaptureRuntimeInstallationService } from './capture-runtime-installation.service';
import {
  CaptureWorkbenchStore,
} from './capture-workbench-store';

@Component({
  selector: 'gx-capture-workbench',
  imports: [
    CaptureRuntimeSetupComponent,
  CaptureWorkbenchHeaderComponent,
    CaptureTaskListComponent,
  ],
  providers: [CaptureWorkbenchStore, CaptureRuntimeInstallationService],
  templateUrl: './capture-angular.html',
  styleUrl: './capture-angular.css',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureWorkbenchComponent {
  /** @deprecated Configure the instance-scoped CaptureWorkbenchStore instead. */
  readonly config = input<CaptureWorkbenchConfig>({});
  /** @deprecated Register a CaptureClient provider or configure the store. */
  readonly client = input<CaptureClient | null>(null);
  /** @deprecated Register a provider or configure the store. */
  readonly structuringProvider = input<CaptureStructuringProvider | null>(null);
  /** @deprecated Register a provider or configure the store. */
  readonly preprocessor = input<CapturePreprocessor | null>(null);

  readonly completed = output<CaptureCompletedEvent>();
  readonly failed = output<CaptureFailedEvent>();
  readonly canceled = output<CaptureTaskView>();
  readonly taskChanged = output<CaptureTaskView>();

  protected readonly store = inject(CaptureWorkbenchStore);
  readonly tasks = this.store.tasks;
  readonly runtime = this.store.runtime;
  readonly installation = this.store.installation;

  private readonly configurationEffect = effect(() => {
    const options: CaptureWorkbenchStoreOptions = {
      config: this.config(),
      client: this.client(),
      structuringProvider: this.structuringProvider(),
      preprocessor: this.preprocessor(),
    };
    this.store.configure(options);
  });

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

  /** @deprecated Call the instance-scoped store command instead. */
  enqueueFiles(files: readonly File[]): void {
    this.store.enqueueFiles(files);
  }

  /** @deprecated Call the instance-scoped store command instead. */
  cancel(taskId: string): Promise<void> {
    return this.store.cancel(taskId);
  }

  /** @deprecated Call the instance-scoped store command instead. */
  reconcile(taskId: string): Promise<void> {
    return this.store.reconcile(taskId);
  }

  /** @deprecated Call the instance-scoped store command instead. */
  remove(taskId: string): Promise<void> {
    return this.store.remove(taskId);
  }

  /** @deprecated Call the instance-scoped store command instead. */
  refreshRuntime(): void {
    this.store.refreshRuntime();
  }

  /** @deprecated Call the instance-scoped store command instead. */
  installMissingRequirements(): Promise<void> {
    return this.store.installMissingRequirements();
  }

  /** @deprecated Call the instance-scoped store command instead. */
  cancelInstallation(): Promise<void> {
    return this.store.cancelInstallation();
  }
}
