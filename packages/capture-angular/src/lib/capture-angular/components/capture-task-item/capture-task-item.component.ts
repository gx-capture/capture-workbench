import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { type CaptureTaskView } from '../../../contracts';
import { CaptureWorkbenchStore } from '../../services/capture-workbench-store/capture-workbench-store';

@Component({
  selector: 'gx-capture-task-item',
  imports: [ReactiveFormsModule],
  template: `
    <li [attr.data-task-status]="task().status">
      <div class="task-heading">
        <div>
          <strong>{{ task().fileName }}</strong>
          <span
            >{{ task().sourceKind }} · {{ task().stage ?? task().status }}</span
          >
        </div>
        <span class="status-badge" [attr.data-status]="task().status">
          {{ task().status }}
        </span>
      </div>

      @if (task().status === 'awaiting_confirmation' && task().raw) {
        <section class="ocr-review" aria-label="OCR review">
          <h3>{{ store.config().labels?.reviewTitle ?? 'Review OCR text' }}</h3>
          <p class="muted">
            {{
              store.config().labels?.reviewDescription ??
                'Check the extracted text before saving it to the host application.'
            }}
          </p>
          @for (
            segment of task().raw?.segments ?? [];
            track segment.segmentId
          ) {
            <article class="ocr-review-segment">
              <div class="ocr-review-heading">
                <strong>
                  {{
                    segment.locator.kind === 'page'
                      ? 'Page ' + segment.locator.page
                      : 'Segment ' + (segment.order + 1)
                  }}
                </strong>
                @if (store.isReviewed(task(), segment.segmentId)) {
                  <span class="review-edited">Edited</span>
                }
              </div>
              <div class="ocr-review-columns">
                <div>
                  <span class="review-label">{{
                    store.config().labels?.originalText ?? 'Original OCR'
                  }}</span>
                  <pre>{{ segment.text }}</pre>
                </div>
                <div>
                  <span class="review-label">{{
                    store.config().labels?.reviewedText ?? 'Text to save'
                  }}</span>
                  @if (store.config().reviewEditable ?? false) {
                    <textarea
                      [formControl]="
                        reviewControl(task(), segment.segmentId)
                      "
                      rows="6"
                    ></textarea>
                    @if (store.isReviewed(task(), segment.segmentId)) {
                      <button
                        type="button"
                        class="ghost"
                        (click)="
                          restoreOriginal(
                            task(),
                            segment.segmentId,
                            segment.text
                          )
                        "
                      >
                        {{
                          store.config().labels?.restoreOriginal ??
                            'Restore original'
                        }}
                      </button>
                    }
                  } @else {
                    <pre>{{
                      store.reviewedText(task(), segment.segmentId)
                    }}</pre>
                  }
                </div>
              </div>
            </article>
          }
          @if (task().error) {
            <p class="error" role="alert">{{ task().error?.message }}</p>
          }
          <div class="task-actions">
            <button
              type="button"
              class="primary"
              (click)="store.confirm(task().id)"
            >
              {{ store.config().labels?.confirmReview ?? 'Confirm OCR' }}
            </button>
            <button
              type="button"
              class="secondary"
              (click)="store.cancel(task().id)"
            >
              {{ store.config().labels?.discardReview ?? 'Discard' }}
            </button>
          </div>
        </section>
      }

      @if (task().status === 'queued' || task().status === 'processing') {
        <progress max="100" [value]="task().progress">
          {{ task().progress }}%
        </progress>
        <div class="task-actions">
          <button
            type="button"
            class="secondary"
            (click)="store.cancel(task().id)"
          >
            {{ store.config().labels?.cancel ?? 'Cancel' }}
          </button>
        </div>
      }

      @if (task().status === 'reconciliation_required') {
        <p class="reconciliation-warning" role="status">
          The runtime terminal state is unknown. Check its status or request
          cancellation; capture will not be retried automatically.
        </p>
        <div class="task-actions reconciliation-actions">
          <button
            type="button"
            class="secondary"
            (click)="store.reconcile(task().id)"
          >
            {{ store.config().labels?.reconcile ?? 'Check status' }}
          </button>
          <button
            type="button"
            class="secondary"
            (click)="store.cancel(task().id)"
          >
            {{
              store.config().labels?.cancelAndReconcile ?? 'Cancel and check'
            }}
          </button>
        </div>
      }

      @if (task().error) {
        <p
          [class.error]="task().status !== 'reconciliation_required'"
          [class.reconciliation-warning]="
            task().status === 'reconciliation_required'
          "
          role="alert"
        >
          <strong>{{ task().error?.code }}</strong> ·
          {{ task().error?.message }}
        </p>
      }

      @if (task().result) {
        <pre class="result-preview">{{ store.renderedResult(task()) }}</pre>
        <div class="task-actions">
          <button
            type="button"
            class="secondary"
            (click)="store.exportResult(task(), 'json')"
          >
            {{ store.config().labels?.exportJson ?? 'Export JSON' }}
          </button>
          <button
            type="button"
            class="secondary"
            (click)="store.exportResult(task(), 'text')"
          >
            {{ store.config().labels?.exportText ?? 'Export text' }}
          </button>
        </div>
      }

      @if (task().raw) {
        <details class="raw-diagnostics">
          <summary>Raw extraction diagnostics</summary>
          <p>
            This data is diagnostic only. It was not emitted as a completed
            capture document.
          </p>
          <pre>{{ task().raw?.sourceText }}</pre>
          <button
            type="button"
            class="secondary"
            (click)="store.exportRaw(task())"
          >
            {{ store.config().labels?.exportRaw ?? 'Export raw diagnostics' }}
          </button>
        </details>
      }

      @if (
        task().status === 'completed' ||
        task().status === 'failed' ||
        task().status === 'canceled'
      ) {
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly reviewControls = new Map<string, FormControl<string>>();

  protected reviewControl(
    task: CaptureTaskView,
    segmentId: string,
  ): FormControl<string> {
    const key = `${task.id}:${segmentId}`;
    const existing = this.reviewControls.get(key);
    if (existing) return existing;

    const control = new FormControl(
      this.store.reviewedText(task, segmentId),
      { nonNullable: true },
    );
    control.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((reviewedText) => {
        this.store.updateReview(task.id, segmentId, reviewedText);
      });
    this.reviewControls.set(key, control);
    return control;
  }

  protected restoreOriginal(
    task: CaptureTaskView,
    segmentId: string,
    originalText: string,
  ): void {
    this.reviewControl(task, segmentId).setValue(originalText, {
      emitEvent: false,
    });
    this.store.restoreOriginal(task, segmentId);
  }
}
