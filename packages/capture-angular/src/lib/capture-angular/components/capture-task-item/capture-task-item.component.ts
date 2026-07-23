import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { type CaptureTaskView } from '../../../contracts';
import { CaptureWorkbenchStore } from '../../services/capture-workbench-store/capture-workbench-store';

@Component({
  selector: 'gx-capture-task-item',
  template: `
    <li [attr.data-task-status]="task().status">
      <div class="task-heading">
        <div>
          <strong>{{ task().fileName }}</strong>
          <span>{{ task().sourceKind }} · {{ task().stage ?? task().status }}</span>
        </div>
        <span class="status-badge" [attr.data-status]="task().status">
          {{ task().status }}
        </span>
      </div>

      @if (task().status === 'queued' || task().status === 'processing') {
        <progress max="100" [value]="task().progress">{{ task().progress }}%</progress>
        <div class="task-actions">
          <button type="button" class="secondary" (click)="store.cancel(task().id)">
            {{ store.config().labels?.cancel ?? 'Cancel' }}
          </button>
        </div>
      }

      @if (task().status === 'reconciliation_required') {
        <p class="reconciliation-warning" role="status">
          The runtime terminal state is unknown. Check its status or request cancellation; capture will not be retried automatically.
        </p>
        <div class="task-actions reconciliation-actions">
          <button type="button" class="secondary" (click)="store.reconcile(task().id)">
            {{ store.config().labels?.reconcile ?? 'Check status' }}
          </button>
          <button type="button" class="secondary" (click)="store.cancel(task().id)">
            {{ store.config().labels?.cancelAndReconcile ?? 'Cancel and check' }}
          </button>
        </div>
      }

      @if (task().error) {
        <p
          [class.error]="task().status !== 'reconciliation_required'"
          [class.reconciliation-warning]="task().status === 'reconciliation_required'"
          role="alert"
        >
          <strong>{{ task().error?.code }}</strong> · {{ task().error?.message }}
        </p>
      }

      @if (task().result) {
        <pre class="result-preview">{{ store.renderedResult(task()) }}</pre>
        <div class="task-actions">
          <button type="button" class="secondary" (click)="store.exportResult(task(), 'json')">
            {{ store.config().labels?.exportJson ?? 'Export JSON' }}
          </button>
          <button type="button" class="secondary" (click)="store.exportResult(task(), 'text')">
            {{ store.config().labels?.exportText ?? 'Export text' }}
          </button>
        </div>
      }

      @if (task().raw) {
        <details class="raw-diagnostics">
          <summary>Raw extraction diagnostics</summary>
          <p>This data is diagnostic only. It was not emitted as a completed capture document.</p>
          <pre>{{ task().raw?.sourceText }}</pre>
          <button type="button" class="secondary" (click)="store.exportRaw(task())">
            {{ store.config().labels?.exportRaw ?? 'Export raw diagnostics' }}
          </button>
        </details>
      }

      @if (task().status === 'completed' || task().status === 'failed' || task().status === 'canceled') {
        <div class="task-actions remove-action">
          <button type="button" class="ghost" (click)="store.remove(task().id)">
            {{ store.config().labels?.remove ?? 'Clear data' }}
          </button>
        </div>
      }
    </li>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureTaskItemComponent {
  readonly task = input.required<CaptureTaskView>();
  protected readonly store = inject(CaptureWorkbenchStore);
}
