import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  EMPTY,
  type Observable,
  concatMap,
  defer,
  finalize,
  from,
  map,
  of,
  retry,
  share,
  switchMap,
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
import {
  InstallationTracker,
  type JobEnd,
  type TrackedJob,
  type TrackedRecord,
  backoffDelayMs,
  endOfRecord,
  isActiveStatus,
} from './installation-tracker';

/** The live job with the newest start, else the job with the newest start, else `null`. */
function newestJob<T extends TrackedRecord>(
  jobs: Iterable<TrackedJob<T>>,
): TrackedJob<T> | null {
  let newestLive: TrackedJob<T> | null = null;
  let newest: TrackedJob<T> | null = null;
  for (const job of jobs) {
    if (!newest || job.startOrder > newest.startOrder) newest = job;
    if (isActiveStatus(job.record.status) && (!newestLive || job.startOrder > newestLive.startOrder)) {
      newestLive = job;
    }
  }
  return newestLive ?? newest;
}

function liveJobCount<T extends TrackedRecord>(jobs: ReadonlyMap<string, TrackedJob<T>>): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (isActiveStatus(job.record.status)) count += 1;
  }
  return count;
}

@Injectable({ providedIn: 'root' })
/**
 * Coordinates runtime and model installation workflows for `RecognitionFeaturesStore`.
 * Two `InstallationTracker`s own all polling; the signals here are views derived from them.
 */
export class DesktopInstallationService {
  private readonly runtime = inject(DesktopRuntimeClientService);

  private readonly requirementTracker = new InstallationTracker<RuntimeInstallation>({
    get: (installationId) => this.runtime.getInstallation(installationId),
    list: () => this.runtime.listInstallations(),
    cancel: (installationId) => this.runtime.cancelInstallation(installationId),
    isNotFound: isRuntimeNotFound,
  });
  private readonly modelTracker = new InstallationTracker<StructuringModelInstallation>({
    get: (installationId) => this.runtime.getModelInstallation(installationId),
    list: null,
    cancel: null,
    isNotFound: isRuntimeNotFound,
  });

  /** Requests in flight that can produce an installation: start requests and re-attach listings. */
  private readonly pendingOperations = signal(0);
  /** The re-attach listing in flight; a second re-attach joins it. */
  private pendingReattach$: Observable<void> | null = null;

  /** The requirement whose start request is in flight: the runtime has not answered with an installation yet. */
  readonly startingRequirementId = signal<CaptureRequirementId | null>(null);
  readonly selectedModelOptionId = signal<string | null>(null);

  /** Each requirement installation's end, once, when it happens. */
  readonly requirementEnded$: Observable<JobEnd<RuntimeInstallation>> = this.requirementTracker.ended$;
  /** Each model installation's end, once, when it happens. */
  readonly modelEnded$: Observable<JobEnd<StructuringModelInstallation>> = this.modelTracker.ended$;

  /** True while any installation is live or a request that can produce one is in flight. */
  readonly installing = computed(
    () =>
      liveJobCount(this.requirementTracker.jobs()) > 0 ||
      liveJobCount(this.modelTracker.jobs()) > 0 ||
      this.pendingOperations() > 0,
  );
  /** The progress card's installation: the live one started last, else the one started last. */
  readonly activeInstallation = computed(
    () => newestJob(this.requirementTracker.jobs().values())?.record ?? null,
  );
  readonly activeModelInstallation = computed(
    () => newestJob(this.modelTracker.jobs().values())?.record ?? null,
  );
  /** The model installation's last status request failed; its poll keeps retrying. */
  readonly modelProgressUnavailable = computed(
    () => newestJob(this.modelTracker.jobs().values())?.statusUnavailable ?? false,
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.requirementTracker.dispose();
      this.modelTracker.dispose();
    });
  }

  /** The installation of a requirement: its live one started last, else its one started last. */
  installationFor(requirementId: CaptureRequirementId): RuntimeInstallation | null {
    return this.jobFor(requirementId)?.record ?? null;
  }

  /** True while the status requests of that requirement's installation fail and are being retried. */
  isProgressUnavailable(requirementId: CaptureRequirementId): boolean {
    return this.jobFor(requirementId)?.statusUnavailable ?? false;
  }

  /** Selects the model option used by the next installation request. */
  selectModelOption(optionId: string): void {
    if (this.installing()) return;
    this.selectedModelOptionId.set(optionId);
    this.modelTracker.forgetEnded();
  }

  /**
   * Installs requirements one after another so consent and progress remain
   * ordered. Each one is started, followed and waited for: a completed one
   * moves on, a cancelled one stops the queue, a failed or vanished one errors.
   */
  installRequirements$(
    requirements: readonly RuntimeRequirement[],
  ): Observable<RuntimeInstallation> {
    return from(requirements).pipe(
      concatMap((requirement) => this.installRequirement$(requirement)),
      // A cancelled requirement ends the queue: the user chose to stop, not to skip one requirement.
      takeWhile((installation) => installation.status !== 'cancelled', true),
    );
  }

  /**
   * Cancels a running installation. Only a confirmed cancel stops its poll;
   * a failed cancel leaves it polled and errors.
   */
  cancelInstallation$(installationId?: string): Observable<RuntimeInstallation> {
    const targetId = installationId ?? this.activeInstallation()?.installationId;
    if (!targetId) {
      return EMPTY;
    }
    return this.requirementTracker.cancel$(targetId);
  }

  /**
   * Lists the runtime's installations on startup, after a restart or on
   * request, and follows every one still queued or running. One listing at a
   * time: a second call joins the pending one. A failed listing is retried with
   * the polling backoff, never read as "nothing running". It completes when the
   * listing is done, without waiting for the installations to end.
   */
  reattachInstallations$(): Observable<void> {
    this.pendingReattach$ ??= this.counted$(
      defer(() => this.runtime.listInstallations()).pipe(
        retry({
          delay: (_error: unknown, retryCount: number) => timer(backoffDelayMs(retryCount)),
        }),
      ),
    ).pipe(
      map((items): void => {
        // Newest first; follow oldest first so the newest gets the newest start order.
        for (const item of [...items].reverse()) this.requirementTracker.follow(item);
      }),
      finalize(() => {
        this.pendingReattach$ = null;
      }),
      share(),
    );
    return this.pendingReattach$;
  }

  /**
   * Starts one model installation, follows it and waits for its end. A
   * vanished installation (the runtime no longer knows it) completes without a value.
   */
  installSelectedModel$(optionId: string): Observable<StructuringModelInstallation> {
    return this.counted$(defer(() => {
      this.modelTracker.forgetEnded();
      return this.runtime.startModelInstallation({
        clientRequestId: crypto.randomUUID(),
        optionId,
        consent: true,
      });
    })).pipe(
      switchMap((record) => this.followAndWait$(this.modelTracker, record)),
      switchMap((end) => {
        if (end.outcome === 'vanished') return EMPTY;
        const installation = end.record;
        if (end.outcome === 'completed' && installation) return of(installation);
        return throwError(() => new Error(
          `Runtime model installation ended ${installation?.status ?? end.outcome}${installation?.error?.code ? ` (${installation.error.code})` : ''}.`,
        ));
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
    const clearStarting = (): void => {
      if (this.startingRequirementId() === requirement.requirementId) {
        this.startingRequirementId.set(null);
      }
    };
    return this.counted$(defer(() => {
      this.startingRequirementId.set(requirement.requirementId);
      return this.runtime.startInstallation({
        clientRequestId: crypto.randomUUID(),
        requirementId: requirement.requirementId,
        consent: true,
      });
    })).pipe(
      tap({ next: clearStarting, finalize: clearStarting }),
      switchMap((record) => this.followAndWait$(this.requirementTracker, record)),
      map((end) => {
        if (end.outcome === 'vanished' || !end.record) {
          throw new Error(desktopMessages().installationInterrupted(requirement.displayName));
        }
        if (end.outcome === 'failed') {
          throw new Error(errorMessage(
            end.record.error?.message ??
              desktopMessages().requirementFailed(requirement.displayName),
          ));
        }
        return end.record;
      }),
    );
  }

  /** Follows a just-started installation and waits for its end; a terminal start is its own end. */
  private followAndWait$<T extends TrackedRecord>(
    tracker: InstallationTracker<T>,
    record: T,
  ): Observable<JobEnd<T>> {
    tracker.follow(record);
    return isActiveStatus(record.status)
      ? tracker.endOf$(record.installationId)
      : of(endOfRecord(record));
  }

  /**
   * Counts a request that can produce an installation while it is in flight:
   * released on its answer (the installation is then live or ended), error or unsubscribe.
   */
  private counted$<R>(request$: Observable<R>): Observable<R> {
    return defer(() => {
      this.pendingOperations.update((count) => count + 1);
      let counted = true;
      const release = (): void => {
        if (!counted) return;
        counted = false;
        this.pendingOperations.update((count) => count - 1);
      };
      return request$.pipe(tap({ next: release, finalize: release }));
    });
  }

  private jobFor(requirementId: CaptureRequirementId): TrackedJob<RuntimeInstallation> | null {
    return newestJob(
      [...this.requirementTracker.jobs().values()].filter(
        (job) => job.record.requirementId === requirementId,
      ),
    );
  }
}
