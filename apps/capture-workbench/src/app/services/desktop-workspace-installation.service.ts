import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Subject,
  catchError,
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
  takeUntil,
  takeWhile,
  tap,
  throwError,
  timer,
} from 'rxjs';
import type {
  CaptureRequirementId,
  RuntimeInstallation,
  RuntimeModelInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { errorMessage } from './desktop-workspace.selectors';
import { desktopMessages } from '../i18n/desktop-messages';

@Injectable({ providedIn: 'root' })
/** Coordinates runtime and model installation workflows for the workspace facade. */
export class DesktopWorkspaceInstallationService {
  readonly installing = signal(false);
  readonly activeInstallation = signal<RuntimeInstallation | null>(null);
  readonly installationsByRequirement = signal<
    ReadonlyMap<CaptureRequirementId, RuntimeInstallation>
  >(new Map());
  readonly activeModelInstallation = signal<RuntimeModelInstallation | null>(null);
  readonly selectedModelOptionId = signal<string | null>(null);

  private readonly runtime = inject(DesktopRuntimeClientService);
  /** Stops the running install queue when the user cancels. */
  private readonly cancelled$ = new Subject<void>();

  /** Latest installation record known for a requirement unit, if any. */
  installationFor(requirementId: CaptureRequirementId): RuntimeInstallation | null {
    const active = this.activeInstallation();
    if (active?.requirementId === requirementId) {
      return active;
    }
    return this.installationsByRequirement().get(requirementId) ?? null;
  }

  /** Selects the model option used by the next installation request. */
  selectModelOption(optionId: string): void {
    if (this.installing()) return;
    this.selectedModelOptionId.set(optionId);
    this.activeModelInstallation.set(null);
  }

  /** Installs requirements sequentially so consent and progress remain ordered. */
  installRequirements$(
    requirements: readonly RuntimeRequirement[],
  ): Observable<RuntimeInstallation> {
    this.installing.set(true);
    return from(requirements).pipe(
      concatMap((requirement) => this.installRequirement$(requirement)),
      // A cancelled unit ends the queue: the user chose to stop, not to skip one unit.
      takeWhile((installation) => installation.status !== 'cancelled', true),
      takeUntil(this.cancelled$),
      finalize(() => {
        this.installing.set(false);
      }),
    );
  }

  /** Cancels a running installation and stops its polling loop. */
  cancelInstallation$(installationId?: string): Observable<RuntimeInstallation> {
    const targetId = installationId ?? this.activeInstallation()?.installationId;
    if (!targetId) {
      return EMPTY;
    }
    this.cancelled$.next();
    return this.runtime.cancelInstallation(targetId).pipe(
      tap((installation) => this.recordInstallation(installation)),
    );
  }

  /**
   * Lists existing runtime installations on startup or reload and resumes
   * polling any installation that is still queued or running.
   */
  reattachInstallations$(): Observable<RuntimeInstallation | null> {
    return this.runtime.listInstallations().pipe(
      catchError(() => of<readonly RuntimeInstallation[]>([])),
      switchMap((items) => {
        // The runtime lists the newest first; record oldest first so the newest wins.
        for (const item of [...items].reverse()) {
          this.recordInstallation(item, false);
        }
        const activeItems = items.filter(
          (item) => item.status === 'queued' || item.status === 'running',
        );
        if (activeItems.length === 0) {
          return of(null);
        }
        this.installing.set(true);
        return from(activeItems).pipe(
          concatMap((active) => {
            this.recordInstallation(active);
            return this.pollInstallation$(active, active.requirementId);
          }),
          takeUntil(this.cancelled$),
          finalize(() => {
            this.installing.set(false);
          }),
        );
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
        desktopMessages().manualRequirement(
          requirement.displayName,
          requirement.detail ?? desktopMessages().finishInstallThenRetry,
        ),
      ));
    }
    return this.runtime.startInstallation({
      clientRequestId: crypto.randomUUID(),
      requirementId: requirement.requirementId,
      consent: true,
    }).pipe(
      tap((installation) => this.recordInstallation(installation)),
      switchMap((installation) =>
        this.pollInstallation$(installation, requirement.displayName)),
    );
  }

  private pollInstallation$(
    initial: RuntimeInstallation,
    displayName: string,
  ): Observable<RuntimeInstallation> {
    return of(initial).pipe(
      expand((installation) => {
        if (installation.status !== 'queued' && installation.status !== 'running') {
          return EMPTY;
        }
        return timer(750).pipe(
          switchMap(() => this.runtime.getInstallation(installation.installationId)),
        );
      }),
      tap((installation) => this.recordInstallation(installation)),
      filter(
        (installation) =>
          installation.status !== 'queued' && installation.status !== 'running',
      ),
      take(1),
      map((installation) => {
        if (installation.status !== 'completed' && installation.status !== 'cancelled') {
          throw new Error(errorMessage(
            installation.error?.message ??
              desktopMessages().requirementFailed(displayName),
          ));
        }
        return installation;
      }),
    );
  }

  private recordInstallation(
    installation: RuntimeInstallation,
    setActive = true,
  ): void {
    if (setActive) {
      this.activeInstallation.set(installation);
    }
    this.installationsByRequirement.update((current) => {
      const next = new Map(current);
      next.set(installation.requirementId, installation);
      return next;
    });
  }
}
