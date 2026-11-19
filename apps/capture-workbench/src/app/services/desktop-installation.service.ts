import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  concatWith,
  defer,
  expand,
  filter,
  finalize,
  from,
  map,
  mergeMap,
  type Observable,
  of,
  retry,
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
  StructuringModelInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { errorMessage, isRuntimeNotFound } from './desktop-errors';
import { desktopMessages } from '../i18n/desktop-messages';

const POLL_INTERVAL_MS = 750;
const POLL_RETRY_FIRST_DELAY_MS = 1_000;
/** A failed status request is retried with doubling delays up to this cap, for as long as it keeps failing. */
const POLL_RETRY_DELAY_CAP_MS = 8_000;

function isActiveStatus(status: string): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * One status request, retried without limit until the runtime answers.
 * `defer` sends a new request on each retry. Only a definitive "not found"
 * ends it with an error. `onFailing` reports whether the last request failed.
 */
function statusRequest$<T>(
  request: () => Observable<T>,
  onFailing: (failing: boolean) => void,
): Observable<T> {
  return defer(request).pipe(
    retry({
      delay: (error: unknown, retryCount) => {
        if (isRuntimeNotFound(error)) return throwError(() => error);
        onFailing(true);
        return timer(Math.min(
          POLL_RETRY_FIRST_DELAY_MS * 2 ** (retryCount - 1),
          POLL_RETRY_DELAY_CAP_MS,
        ));
      },
    }),
    tap(() => onFailing(false)),
  );
}

/** Emits `initial`, then each polled status until one is no longer queued or running. */
function pollUntilTerminal$<T extends { readonly status: string }>(
  initial: T,
  fetchNext: (current: T) => Observable<T>,
  onFailing: (failing: boolean) => void,
): Observable<T> {
  return of(initial).pipe(
    expand((current) => {
      if (!isActiveStatus(current.status)) return EMPTY;
      return timer(POLL_INTERVAL_MS).pipe(
        switchMap(() => statusRequest$(() => fetchNext(current), onFailing)),
      );
    }),
  );
}

@Injectable({ providedIn: 'root' })
/** Coordinates runtime and model installation workflows for `RecognitionFeaturesStore`. */
export class DesktopInstallationService {
  readonly installing = signal(false);
  readonly activeInstallation = signal<RuntimeInstallation | null>(null);
  /** The requirement whose start request is in flight: the runtime has not answered with an installation yet. */
  readonly startingRequirementId = signal<CaptureRequirementId | null>(null);
  readonly installationsByRequirement = signal<
    ReadonlyMap<CaptureRequirementId, RuntimeInstallation>
  >(new Map());
  /** Requirements whose last installation status request failed; polling keeps retrying them. */
  readonly progressUnavailableRequirements = signal<ReadonlySet<CaptureRequirementId>>(new Set());
  readonly activeModelInstallation = signal<StructuringModelInstallation | null>(null);
  /** The model installation's last status request failed; polling keeps retrying it. */
  readonly modelProgressUnavailable = signal(false);
  readonly selectedModelOptionId = signal<string | null>(null);

  /** A re-attach is listing or following installations; another one would follow them twice. */
  readonly reattaching = signal(false);

  private readonly runtime = inject(DesktopRuntimeClientService);
  /** Each installation the runtime confirmed as cancelled; it stops that installation's poll only. */
  private readonly cancelled$ = new Subject<RuntimeInstallation>();
  /** Installation ids being polled now, so a re-attach never polls one twice. */
  private readonly followedIds = new Set<string>();

  /** True while this requirement's installation status requests fail and are being retried. */
  isProgressUnavailable(requirementId: CaptureRequirementId): boolean {
    return this.progressUnavailableRequirements().has(requirementId);
  }

  /** Latest installation record known for a requirement, if any. */
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
      // A cancelled requirement ends the queue: the user chose to stop, not to skip one requirement.
      takeWhile((installation) => installation.status !== 'cancelled', true),
      finalize(() => {
        this.startingRequirementId.set(null);
        this.installing.set(false);
      }),
    );
  }

  /**
   * Cancels a running installation. Its poll stops once the runtime confirms
   * the cancel; other installations keep being polled, and a failed cancel
   * leaves the poll running.
   */
  cancelInstallation$(installationId?: string): Observable<RuntimeInstallation> {
    const targetId = installationId ?? this.activeInstallation()?.installationId;
    if (!targetId) {
      return EMPTY;
    }
    return this.runtime.cancelInstallation(targetId).pipe(
      tap((installation) => {
        this.recordInstallation(installation);
        this.cancelled$.next(installation);
      }),
    );
  }

  /**
   * Lists existing runtime installations on startup or reload and resumes
   * polling any installation that is still queued or running and not polled
   * already. A failed listing is retried like a status request, so it never
   * reads as "nothing is running". Each installation is polled on its own, so
   * one that keeps failing does not hold up the others; the first failed
   * installation is reported once all of them have ended.
   */
  reattachInstallations$(): Observable<RuntimeInstallation | null> {
    return defer(() => {
      this.reattaching.set(true);
      return statusRequest$(() => this.runtime.listInstallations(), () => undefined);
    }).pipe(
      switchMap((items) => {
        // The runtime lists the newest first; record oldest first so the newest wins.
        for (const item of [...items].reverse()) {
          if (!this.followedIds.has(item.installationId)) this.recordInstallation(item, false);
        }
        const activeItems = items.filter(
          (item) => isActiveStatus(item.status) && !this.followedIds.has(item.installationId),
        );
        if (activeItems.length === 0) {
          return of(null);
        }
        this.installing.set(true);
        let firstFailure: unknown = null;
        return from(activeItems).pipe(
          mergeMap((active) => {
            this.recordInstallation(active);
            return this.pollInstallation$(active, active.requirementId).pipe(
              catchError((error: unknown) => {
                firstFailure ??= error;
                return EMPTY;
              }),
            );
          }),
          concatWith(defer(() => {
            const failure = firstFailure;
            return failure === null ? EMPTY : throwError(() => failure);
          })),
          finalize(() => {
            this.installing.set(false);
          }),
        );
      }),
      finalize(() => this.reattaching.set(false)),
    );
  }

  /** Starts and polls one model installation until it reaches a terminal state. */
  installSelectedModel$(optionId: string): Observable<StructuringModelInstallation> {
    this.activeModelInstallation.set(null);
    this.installing.set(true);
    return this.runtime.startModelInstallation({
      clientRequestId: crypto.randomUUID(),
      optionId,
      consent: true,
    }).pipe(
      switchMap((initial) => this.followModelInstallation$(initial)),
      filter((installation) => !isActiveStatus(installation.status)),
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

  /**
   * Emits each status of a model installation until it ends. When the runtime
   * no longer knows the installation (for example after a restart), its record
   * is dropped and nothing more is emitted; the store then reloads the options.
   */
  private followModelInstallation$(
    initial: StructuringModelInstallation,
  ): Observable<StructuringModelInstallation> {
    return pollUntilTerminal$(
      initial,
      (current) => this.runtime.getModelInstallation(current.installationId),
      (failing) => this.modelProgressUnavailable.set(failing),
    ).pipe(
      tap((installation) => this.activeModelInstallation.set(installation)),
      catchError((error: unknown) => {
        if (!isRuntimeNotFound(error)) return throwError(() => error);
        this.activeModelInstallation.set(null);
        return EMPTY;
      }),
      finalize(() => this.modelProgressUnavailable.set(false)),
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
    return defer(() => {
      this.startingRequirementId.set(requirement.requirementId);
      return this.runtime.startInstallation({
        clientRequestId: crypto.randomUUID(),
        requirementId: requirement.requirementId,
        consent: true,
      });
    }).pipe(
      tap((installation) => {
        this.startingRequirementId.set(null);
        this.recordInstallation(installation);
      }),
      switchMap((installation) =>
        this.pollInstallation$(installation, requirement.displayName)),
    );
  }

  private pollInstallation$(
    initial: RuntimeInstallation,
    displayName: string,
  ): Observable<RuntimeInstallation> {
    return this.followInstallation$(initial).pipe(
      filter((installation) => !isActiveStatus(installation.status)),
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

  /**
   * Emits and records each status of an installation until it ends. When the
   * runtime no longer knows the installation id, the installation list decides:
   * a listed running installation is followed, a listed ended one is recorded,
   * and none at all drops the stale running record.
   */
  private followInstallation$(initial: RuntimeInstallation): Observable<RuntimeInstallation> {
    const requirementId = initial.requirementId;
    const installationId = initial.installationId;
    let confirmedCancel: RuntimeInstallation | null = null;
    const cancelConfirmed$ = this.cancelled$.pipe(
      filter((cancelled) => cancelled.installationId === installationId),
      tap((cancelled) => {
        confirmedCancel = cancelled;
      }),
    );
    return defer(() => {
      this.followedIds.add(installationId);
      return pollUntilTerminal$(
        initial,
        (current) => this.runtime.getInstallation(current.installationId),
        (failing) => this.setProgressUnavailable(requirementId, failing),
      );
    }).pipe(
      tap((installation) => this.recordInstallation(installation)),
      // The confirmed cancel ends this poll as its last status.
      takeUntil(cancelConfirmed$),
      concatWith(defer(() => (confirmedCancel ? of(confirmedCancel) : EMPTY))),
      finalize(() => this.followedIds.delete(installationId)),
      catchError((error: unknown) => {
        if (!isRuntimeNotFound(error)) return throwError(() => error);
        return statusRequest$(
          () => this.runtime.listInstallations(),
          (failing) => this.setProgressUnavailable(requirementId, failing),
        ).pipe(
          switchMap((items) => {
            // Newest first: the first listed installation of the requirement is its latest.
            const latest = items.find((item) => item.requirementId === requirementId);
            this.dropRunningInstallation(requirementId);
            return latest ? this.followInstallation$(latest) : EMPTY;
          }),
        );
      }),
      finalize(() => this.setProgressUnavailable(requirementId, false)),
    );
  }

  private setProgressUnavailable(requirementId: CaptureRequirementId, failing: boolean): void {
    this.progressUnavailableRequirements.update((current) => {
      if (current.has(requirementId) === failing) return current;
      const next = new Set(current);
      if (failing) next.add(requirementId);
      else next.delete(requirementId);
      return next;
    });
  }

  /** The runtime no longer knows this requirement's running installation: forget it. */
  private dropRunningInstallation(requirementId: CaptureRequirementId): void {
    this.installationsByRequirement.update((current) => {
      const existing = current.get(requirementId);
      if (!existing || !isActiveStatus(existing.status)) return current;
      const next = new Map(current);
      next.delete(requirementId);
      return next;
    });
    const active = this.activeInstallation();
    if (active?.requirementId === requirementId && isActiveStatus(active.status)) {
      this.activeInstallation.set(null);
      this.promoteFollowedInstallation();
    }
  }

  /** Another installation still being polled takes the progress card, if there is one. */
  private promoteFollowedInstallation(): void {
    const next = [...this.installationsByRequirement().values()].find(
      (item) => isActiveStatus(item.status) && this.followedIds.has(item.installationId),
    );
    if (next) this.activeInstallation.set(next);
  }

  /**
   * Records an installation for its requirement. It becomes the active one
   * unless another installation is still running there, so installations
   * followed side by side do not take the progress card from each other.
   */
  private recordInstallation(
    installation: RuntimeInstallation,
    setActive = true,
  ): void {
    const active = this.activeInstallation();
    if (
      setActive &&
      (!active ||
        active.installationId === installation.installationId ||
        !isActiveStatus(active.status))
    ) {
      this.activeInstallation.set(installation);
    }
    this.installationsByRequirement.update((current) => {
      const next = new Map(current);
      next.set(installation.requirementId, installation);
      return next;
    });
    // The card's installation ended while another one is still polled: show that one.
    if (
      this.activeInstallation()?.installationId === installation.installationId &&
      !isActiveStatus(installation.status)
    ) {
      this.promoteFollowedInstallation();
    }
  }
}
