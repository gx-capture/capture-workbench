import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  Subscription,
  catchError,
  concatMap,
  defer,
  expand,
  finalize,
  of,
  takeWhile,
  tap,
  throwError,
} from 'rxjs';
import {
  type CaptureClient,
  type RuntimeInstallationV1,
  type RuntimeRequirementV1,
} from '../../../contracts';
import { MAX_INSTALLATIONS_PER_USER_ACTION } from '../../../constants';
import { CaptureWorkbenchStoreHelpers } from '../capture-workbench-store/capture-workbench-store-helpers';

@Injectable()
export class CaptureRuntimeInstallationService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly helpers = inject(CaptureWorkbenchStoreHelpers);
  readonly installation = signal<RuntimeInstallationV1 | null>(null);
  readonly error = signal<string | undefined>(undefined);
  private controller?: AbortController;
  private installSubscription?: Subscription;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.controller?.abort();
      this.installSubscription?.unsubscribe();
    });
  }

  clearError(): void {
    this.error.set(undefined);
  }

  install(options: {
    readonly client: CaptureClient | null;
    readonly requirements: () => readonly RuntimeRequirementV1[];
    readonly pollIntervalMs: () => number;
    readonly reload: () => Observable<void>;
  }): void {
    const { client } = options;
    if (!client || this.installation()) return;
    const installable = () =>
      options
        .requirements()
        .filter((requirement) => requirement.status === 'installable');
    if (installable().length === 0) return;

    this.installSubscription?.unsubscribe();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const completedRequirementIds = new Set<string>();
    const requestIds = new Map<string, string>();
    let installationsStarted = 0;

    const installNext = (): Observable<void> =>
      defer(() => {
        this.helpers.throwIfAborted(signal);
        const requirement = installable().find(
          (candidate) => !completedRequirementIds.has(candidate.requirementId),
        );
        if (!requirement) {
          if (
            installationsStarted === MAX_INSTALLATIONS_PER_USER_ACTION &&
            installable().some(
              (candidate) =>
                !completedRequirementIds.has(candidate.requirementId),
            )
          ) {
            return throwError(
              () =>
                new Error(
                  'Runtime installation stopped after reaching the safety limit.',
                ),
            );
          }
          return of(undefined);
        }
        if (installationsStarted >= MAX_INSTALLATIONS_PER_USER_ACTION) {
          return throwError(
            () =>
              new Error(
                'Runtime installation stopped after reaching the safety limit.',
              ),
          );
        }

        const request = {
          clientRequestId:
            requestIds.get(requirement.requirementId) ?? crypto.randomUUID(),
          requirementId: requirement.requirementId,
          consent: true,
        } as const;
        requestIds.set(requirement.requirementId, request.clientRequestId);
        installationsStarted += 1;

        return this.helpers
          .retryUncertainResponse(
            () => client.startInstallation(request, signal),
            signal,
          )
          .pipe(
            tap((installation) => this.installation.set(installation)),
            concatMap((installation) =>
              pollInstallation(
                client,
                installation,
                options.pollIntervalMs,
                signal,
                (current) => this.installation.set(current),
              ),
            ),
            concatMap((installation) => {
              if (installation.status !== 'completed') return EMPTY;
              completedRequirementIds.add(requirement.requirementId);
              this.installation.set(null);
              return options.reload();
            }),
            concatMap(() => installNext()),
          );
      });

    this.installSubscription = installNext()
      .pipe(
        catchError((error: unknown) => {
          if (!this.helpers.isAbortError(error)) {
            this.error.set(
              this.helpers.errorMessage(error, 'Runtime installation failed.'),
            );
          }
          return of(undefined);
        }),
        finalize(() => {
          this.controller = undefined;
          if (this.installation()?.status === 'completed')
            this.installation.set(null);
        }),
      )
      .subscribe();
  }

  cancel(client: CaptureClient | null): void {
    const installation = this.installation();
    if (!installation || !client) return;
    this.controller?.abort();
    client.cancelInstallation(installation.installationId).subscribe({
      next: (canceled) => this.installation.set(canceled),
      error: (error: unknown) =>
        this.error.set(
          this.helpers.errorMessage(
            error,
            'Unable to cancel runtime installation.',
          ),
        ),
    });
  }
}

function pollInstallation(
  client: CaptureClient,
  initial: RuntimeInstallationV1,
  pollIntervalMs: () => number,
  signal: AbortSignal,
  onInstallation: (installation: RuntimeInstallationV1) => void,
): Observable<RuntimeInstallationV1> {
  const read = (installationId: string): Observable<RuntimeInstallationV1> =>
    abortableDelay(pollIntervalMs(), signal).pipe(
      concatMap(() => client.getInstallation(installationId, signal)),
    );

  return of(initial).pipe(
    tap(onInstallation),
    expand((installation) =>
      installation.status === 'queued' || installation.status === 'running'
        ? read(installation.installationId)
        : EMPTY,
    ),
    takeWhile(
      (installation) =>
        installation.status === 'queued' || installation.status === 'running',
      true,
    ),
    tap(onInstallation),
  );
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    if (signal.aborted) {
      subscriber.error(createAbortError());
      return;
    }
    const timeout = setTimeout(
      () => {
        subscriber.next();
        subscriber.complete();
      },
      Math.max(0, milliseconds),
    );
    const abort = (): void => {
      clearTimeout(timeout);
      subscriber.error(createAbortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    return () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    };
  });
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
