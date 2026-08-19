import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  concatMap,
  expand,
  filter,
  finalize,
  from,
  map,
  type Observable,
  of,
  switchMap,
  take,
  tap,
  throwError,
  timer,
} from 'rxjs';
import type {
  RuntimeInstallation,
  RuntimeModelInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { errorMessage } from './desktop-workspace.selectors';

@Injectable({ providedIn: 'root' })
/** Coordinates runtime and model installation workflows for the workspace facade. */
export class DesktopWorkspaceInstallationService {
  readonly installing = signal(false);
  readonly activeInstallation = signal<RuntimeInstallation | null>(null);
  readonly activeModelInstallation = signal<RuntimeModelInstallation | null>(null);
  readonly selectedModelOptionId = signal<string | null>(null);

  private readonly runtime = inject(DesktopRuntimeClientService);

  /** Selects the model option used by the next installation request. */
  selectModelOption(optionId: string): void {
    if (this.installing()) return;
    this.selectedModelOptionId.set(optionId);
    this.activeModelInstallation.set(null);
  }

  /** Installs requirements sequentially so consent and progress remain ordered. */
  installCoreRequirements$(
    requirements: readonly RuntimeRequirement[],
  ): Observable<RuntimeInstallation> {
    this.installing.set(true);
    return from(requirements).pipe(
      concatMap((requirement) => this.installRequirement$(requirement)),
      finalize(() => {
        this.installing.set(false);
      }),
    );
  }

  /** Starts and polls one model installation until it reaches a terminal state. */
  installSelectedModel$(optionId: string): Observable<RuntimeModelInstallation> {
    this.activeModelInstallation.set(null);
    this.installing.set(true);
    return this.runtime.startModelInstallation({
      clientRequestId: crypto.randomUUID(),
      optionId,
      consent: true,
    }).pipe(
      expand((installation) => {
        if (installation.status !== 'queued' && installation.status !== 'running') return EMPTY;
        return timer(750).pipe(
          switchMap(() => this.runtime.getModelInstallation(installation.installationId)),
        );
      }),
      tap((installation) => this.activeModelInstallation.set(installation)),
      filter((installation) => installation.status !== 'queued' && installation.status !== 'running'),
      take(1),
      switchMap((installation) => installation.status === 'completed'
        ? of(installation)
        : throwError(() => new Error(
          `Runtime model installation ended ${installation.status}${installation.error?.code ? ` (${installation.error.code})` : ''}.`,
        ))),
      finalize(() => {
        this.installing.set(false);
      }),
    );
  }

  private installRequirement$(requirement: RuntimeRequirement): Observable<RuntimeInstallation> {
    if (requirement.status === 'manual_action_required') {
      return throwError(() => new Error(
        `${requirement.displayName} 需要手動處理：${requirement.detail ?? '請完成安裝後再試。'}`,
      ));
    }
    return this.runtime.startInstallation({
      clientRequestId: crypto.randomUUID(),
      requirementId: requirement.requirementId,
      consent: true,
    }).pipe(
      expand((installation) => {
        if (installation.status !== 'queued' && installation.status !== 'running') return EMPTY;
        return timer(750).pipe(
          switchMap(() => this.runtime.getInstallation(installation.installationId)),
        );
      }),
      tap((installation) => this.activeInstallation.set(installation)),
      filter(
        (installation) => installation.status !== 'queued' && installation.status !== 'running',
      ),
      take(1),
      map((installation) => {
        if (installation.status !== 'completed') {
          throw new Error(errorMessage(
            installation.error?.message ?? `${requirement.requirementId} 安裝失敗。`,
          ));
        }
        return installation;
      }),
    );
  }
}
