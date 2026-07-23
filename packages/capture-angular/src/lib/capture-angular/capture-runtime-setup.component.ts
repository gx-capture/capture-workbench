import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CaptureWorkbenchStore } from './capture-workbench-store';

@Component({
  selector: 'gx-capture-runtime-setup',
  template: `
    <section class="runtime-card" aria-labelledby="capture-runtime-title">
      <div class="runtime-heading">
        <div>
          <p class="eyebrow">Runtime</p>
          <h2 id="capture-runtime-title">
            {{ store.config().labels?.runtimeTitle ?? 'Capture runtime setup' }}
          </h2>
        </div>
        <span class="status-badge" [attr.data-status]="store.runtime().status">
          {{ store.runtime().status }}
        </span>
      </div>

      @if (store.runtime().status === 'checking') {
        <p class="muted" aria-live="polite">Checking runtime capabilities</p>
      } @else if (store.runtime().status === 'ready') {
        <p class="runtime-ready" aria-live="polite">
          {{ store.config().labels?.runtimeReady ?? 'Runtime is ready' }}
          @if (store.runtime().ready; as ready) {
            <span>v{{ ready.runtimeVersion }}</span>
          }
        </p>
      } @else if (store.runtime().status === 'incompatible' || store.runtime().status === 'error') {
        <p class="error" role="alert">{{ store.runtime().error }}</p>
        <button type="button" class="secondary" (click)="store.refreshRuntime()">
          {{ store.config().labels?.retryRuntime ?? 'Check again' }}
        </button>
      }

      @if (store.requiredRequirements().length > 0) {
        <ul class="requirements" aria-label="Runtime requirements">
          @for (requirement of store.requiredRequirements(); track requirement.requirementId) {
            <li [attr.data-requirement-id]="requirement.requirementId">
              <div>
                <strong>{{ requirement.displayName }}</strong>
                @if (requirement.detail) {
                  <span>{{ requirement.detail }}</span>
                }
                @if (requirement.status === 'manual_action_required' || requirement.status === 'unavailable') {
                  <span class="requirement-guidance" role="status">
                    {{ requirement.status === 'manual_action_required'
                      ? 'Manual action is required. Follow the runtime guidance, then check again.'
                      : 'This capability is unavailable on the current system.' }}
                  </span>
                }
              </div>
              <span class="requirement-status" [attr.data-status]="requirement.status">
                {{ requirement.status }}
              </span>
            </li>
          }
        </ul>
      }

      @if (store.installation(); as activeInstallation) {
        <div class="installation" aria-live="polite">
          <div>
            <span>Installing {{ activeInstallation.requirementId }}</span>
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
              Automatic installation is unavailable. Complete the manual action, then check again.
            </p>
          }
        </div>
      } @else if (store.installableRequirements().length > 0 && store.runtime().status !== 'incompatible') {
        <button type="button" class="primary" (click)="store.installMissingRequirements()">
          {{ store.config().labels?.installRuntime ?? 'Install missing runtime' }}
        </button>
        <p class="consent-note">Installation starts only after this explicit action.</p>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureRuntimeSetupComponent {
  protected readonly store = inject(CaptureWorkbenchStore);
}
