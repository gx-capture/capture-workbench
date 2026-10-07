import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CaptureWorkbenchStore } from '../../services/capture-workbench-store/capture-workbench-store';
import { CaptureRuntimeComputeStatusComponent } from '../capture-runtime-compute-status/capture-runtime-compute-status.component';

@Component({
  selector: 'gx-capture-runtime-setup',
  imports: [CaptureRuntimeComputeStatusComponent],
  template: `
    <section class="runtime-card" aria-labelledby="capture-runtime-title" data-testid="capture-runtime-setup">
      <div class="runtime-heading">
        <div>
          <h2 id="capture-runtime-title">
            {{ m().runtimeTitle }}
          </h2>
        </div>
        <span class="status-badge" [attr.data-status]="store.runtime().status">
          {{ m().runtimeStatus[store.runtime().status] ?? store.runtime().status }}
        </span>
      </div>

      @if (store.runtime().status === 'checking') {
        <p class="muted" aria-live="polite">{{ m().checking }}</p>
      } @else if (store.runtime().status === 'ready') {
        @if (store.runtime().ready; as ready) {
          @if (m().runtimeReady; as runtimeReady) {
            <p class="runtime-ready" aria-live="polite">{{ runtimeReady }}</p>
          }
          <gx-capture-runtime-compute-status
            [preflight]="ready.ocrCompute"
            [gpuLabel]="m().gpuAcceleration"
            [cpuNotice]="m().cpuNotice"
          />
        }
      } @else if (store.runtime().status === 'incompatible' || store.runtime().status === 'error') {
        <p class="error" role="alert">{{ store.runtime().error }}</p>
        <button type="button" class="secondary" (click)="store.refreshRuntime()">
          {{ m().retryRuntime }}
        </button>
      }

      @if (store.requiredRequirements().length > 0) {
        <ul class="requirements" [attr.aria-label]="m().requiredComponents">
          @for (requirement of store.requiredRequirements(); track requirement.requirementId) {
            <li data-testid="capture-runtime-requirement" [attr.data-requirement-id]="requirement.requirementId" [attr.data-status]="requirement.status">
              <div>
                <strong>{{ requirement.displayName }}</strong>
                @if (requirement.detail) {
                  <span>{{ requirement.detail }}</span>
                }
                @if (requirement.status === 'manual_action_required' || requirement.status === 'unavailable') {
                  <span class="requirement-guidance" role="status">
                    {{ requirement.status === 'manual_action_required'
                      ? m().manualAction
                      : m().unavailableHere }}
                  </span>
                }
              </div>
              <span class="requirement-status" [attr.data-status]="requirement.status">
                {{ m().requirementStatus[requirement.status] ?? requirement.status }}
              </span>
            </li>
          }
        </ul>
      }

      @if (store.installation(); as activeInstallation) {
        <div class="installation" aria-live="polite">
          <div>
            <span>{{ m().installing }} {{ requirementName(activeInstallation.requirementId) }}</span>
            <strong>{{ store.installationProgress(activeInstallation.progress) }}%</strong>
          </div>
          <progress max="100" [value]="store.installationProgress(activeInstallation.progress)">
            {{ store.installationProgress(activeInstallation.progress) }}%
          </progress>
          @if (activeInstallation.status === 'queued' || activeInstallation.status === 'running') {
            <button type="button" class="secondary" (click)="store.cancelInstallation()">
              {{ m().cancel }}
            </button>
          }
          @if (activeInstallation.error) {
            <p class="error" role="alert">{{ activeInstallation.error.message }}</p>
          } @else if (activeInstallation.status === 'manual_action_required') {
            <p class="requirement-guidance" role="status">
              {{ m().manualInstall }}
            </p>
          }
        </div>
      } @else if (store.installableRequirements().length > 0 && store.runtime().status === 'needs-setup' && store.runtime().ready?.ready === true) {
        <button type="button" class="primary" data-testid="capture-runtime-install" (click)="store.installMissingRequirements()">
          {{ m().installRuntime }}
        </button>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureRuntimeSetupComponent {
  protected readonly store = inject(CaptureWorkbenchStore);
  protected readonly m = this.store.messages;

  protected requirementName(requirementId: string): string {
    return (
      this.store
        .requiredRequirements()
        .find((requirement) => requirement.requirementId === requirementId)
        ?.displayName ?? requirementId
    );
  }
}
