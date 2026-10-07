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
    <li data-testid="capture-task" [attr.data-task-id]="task().id" [attr.data-task-status]="task().status">
      <div class="task-heading">
        <div>
          <strong>{{ task().fileName }}</strong>
          @if (task().status === 'processing' && m().taskStage[task().stage ?? '']; as stage) {
            <span>{{ stage }}</span>
          }
        </div>
        <span class="status-badge" [attr.data-status]="task().status">
          {{ m().taskStatus[task().status] ?? task().status }}
        </span>
      </div>

      @if (task().status === 'awaiting_confirmation' && task().raw) {
        <section class="ocr-review" [attr.aria-label]="m().reviewTitle">
          <h3>{{ m().reviewTitle }}</h3>
          @if (m().reviewDescription; as reviewDescription) {
            <p class="muted">{{ reviewDescription }}</p>
          }
          @for (
            segment of task().raw?.segments ?? [];
            track segment.segmentId
          ) {
            <article class="ocr-review-segment">
              <div class="ocr-review-heading">
                <strong>
                  {{
                    segment.locator.kind === 'page'
                      ? m().page(segment.locator.page)
                      : m().segment(segment.order + 1)
                  }}
                </strong>
                @if (store.isReviewed(task(), segment.segmentId)) {
                  <span class="review-edited">{{ m().edited }}</span>
                }
              </div>
              <div class="ocr-review-columns">
                <div>
                  <span class="review-label">{{
                    m().originalText
                  }}</span>
                  <pre>{{ segment.text }}</pre>
                </div>
                <div>
                  <span class="review-label">{{
                    m().reviewedText
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
                          m().restoreOriginal
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
              {{ m().confirmReview }}
            </button>
            <button
              type="button"
              class="secondary"
              (click)="store.cancel(task().id)"
            >
              {{ m().discardReview }}
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
            {{ m().cancel }}
          </button>
        </div>
      }

      @if (task().status === 'reconciliation_required') {
        <p class="reconciliation-warning" role="status">
          {{ m().unknownProgress }}
        </p>
        <div class="task-actions reconciliation-actions">
          <button
            type="button"
            class="secondary"
            (click)="store.reconcile(task().id)"
          >
            {{ m().reconcile }}
          </button>
          <button
            type="button"
            class="secondary"
            (click)="store.cancel(task().id)"
          >
            {{
              m().cancelAndReconcile
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
          [attr.data-error-code]="task().error?.code"
          role="alert"
        >
          {{ task().error?.message }}
        </p>
      }

      @if (task().result) {
        <pre class="result-preview" data-testid="capture-result">{{ store.renderedResult(task()) }}</pre>
        <dl class="result-provenance" data-testid="capture-provenance">
          <div
            data-testid="capture-extraction-provenance"
            [attr.data-engine]="task().result?.extractionEngine?.engine"
            [attr.data-model]="task().result?.extractionEngine?.model"
            [attr.data-device]="task().result?.extractionEngine?.device"
            [attr.data-digest]="task().result?.extractionEngine?.digest"
          >
            <dt>{{ m().model }}</dt>
            <dd>{{ task().result?.extractionEngine?.model }}</dd>
          </div>
        </dl>
        <div class="task-actions">
          <button
            type="button"
            class="secondary"
            (click)="store.exportResult(task(), 'json')"
          >
            {{ m().exportJson }}
          </button>
          <button
            type="button"
            class="secondary"
            (click)="store.exportResult(task(), 'text')"
          >
            {{ m().exportText }}
          </button>
        </div>
      }

      @if (task().raw) {
        <details class="raw-diagnostics">
          <summary>{{ m().rawText }}</summary>
          <pre data-testid="capture-raw">{{ task().raw?.sourceText }}</pre>
          <ol class="raw-segments" data-testid="capture-raw-segments">
            @for (segment of task().raw?.segments ?? []; track segment.segmentId) {
              <li data-testid="capture-raw-segment" [attr.data-segment-id]="segment.segmentId" [attr.data-order]="segment.order" [attr.data-locator-kind]="segment.locator.kind" [attr.data-page]="segment.locator.kind === 'page' ? segment.locator.page : null" [attr.data-start-ms]="segment.locator.kind === 'time' ? segment.locator.startMs : null" [attr.data-end-ms]="segment.locator.kind === 'time' ? segment.locator.endMs : null">
                {{ segment.text }}
              </li>
            }
          </ol>
          <button
            type="button"
            class="secondary"
            (click)="store.exportRaw(task())"
          >
            {{ m().exportRaw }}
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
            {{ m().remove }}
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
  protected readonly m = this.store.messages;
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
