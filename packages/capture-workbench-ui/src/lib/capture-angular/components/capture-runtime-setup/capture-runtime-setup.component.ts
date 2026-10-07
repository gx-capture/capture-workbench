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
            {{ store.config().labels?.runtimeTitle ?? 'Setup' }}
          </h2>
        </div>
        <span class="status-badge" [attr.data-status]="store.runtime().status">
          {{ runtimeStatusLabel(store.runtime().status) }}
        </span>
      </div>

      @if (store.runtime().status === 'checking') {
        <p class="muted" aria-live="polite">Checking…</p>
      } @else if (store.runtime().status === 'ready') {
        @if (store.runtime().ready; as ready) {
          @if (store.config().labels?.runtimeReady; as runtimeReady) {
            <p class="runtime-ready" aria-live="polite">{{ runtimeReady }}</p>
          }
          <gx-capture-runtime-compute-status [preflight]="ready.ocrCompute" />
        }
      } @else if (store.runtime().status === 'incompatible' || store.runtime().status === 'error') {
        <p class="error" role="alert">{{ store.runtime().error }}</p>
        <button type="button" class="secondary" (click)="store.refreshRuntime()">
          {{ store.config().labels?.retryRuntime ?? 'Check again' }}
        </button>
      }

      @if (store.requiredRequirements().length > 0) {
        <ul class="requirements" aria-label="Required components">
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
                      ? 'Finish this step yourself, then check again.'
                      : 'Not available on this computer.' }}
                  </span>
                }
              </div>
              <span class="requirement-status" [attr.data-status]="requirement.status">
                {{ requirementStatusLabel(requirement.status) }}
              </span>
            </li>
          }
        </ul>
      }

      @if (store.installation(); as activeInstallation) {
        <div class="installation" aria-live="polite">
          <div>
            <span>Installing {{ requirementName(activeInstallation.requirementId) }}</span>
            <strong>{{ store.installationProgress(activeInstallation.progress) }}%</strong>
          </div>
          <progress max="100" [value]="store.installationProgress(activeInstallation.progress)">
            {{ store.installationProgress(activeInstallation.progress) }}%
          </progress>
          @if (activeInstallation.status === 'queued' || activeInstallation.status === 'running') {
            <button type="button" class="secondary" (click)="store.cancelInstallation()">
              {{ store.config().labels?.cancel ?? 'Cancel' }}
            </button>
          }
          @if (activeInstallation.error) {
            <p class="error" role="alert">{{ activeInstallation.error.message }}</p>
          } @else if (activeInstallation.status === 'manual_action_required') {
            <p class="requirement-guidance" role="status">
              This cannot be installed automatically. Finish the step yourself, then check again.
            </p>
          }
        </div>
      } @else if (store.installableRequirements().length > 0 && store.runtime().status === 'needs-setup' && store.runtime().ready?.ready === true) {
        <button type="button" class="primary" data-testid="capture-runtime-install" (click)="store.installMissingRequirements()">
          {{ store.config().labels?.installRuntime ?? 'Download and install' }}
        </button>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureRuntimeSetupComponent {
  protected readonly store = inject(CaptureWorkbenchStore);

  protected runtimeStatusLabel(status: string): string {
    return RUNTIME_STATUS_LABELS[status] ?? status;
  }

  protected requirementStatusLabel(status: string): string {
    return REQUIREMENT_STATUS_LABELS[status] ?? status;
  }

  protected requirementName(requirementId: string): string {
    return (
      this.store
        .requiredRequirements()
        .find((requirement) => requirement.requirementId === requirementId)
        ?.displayName ?? requirementId
    );
  }
}

const RUNTIME_STATUS_LABELS: Readonly<Record<string, string>> = {
  checking: 'Checking',
  ready: 'Ready',
  'needs-setup': 'Setup needed',
  incompatible: 'Update needed',
  error: 'Unavailable',
};

const REQUIREMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  ready: 'Installed',
  missing: 'Not installed',
  installable: 'Not installed',
  manual_action_required: 'Action needed',
  unavailable: 'Unavailable',
};
