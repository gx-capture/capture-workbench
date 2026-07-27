import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  map,
  of,
  throwError,
  timer,
} from 'rxjs';
import {
  DEFAULT_RUNTIME_READINESS_POLL_INTERVAL_MS,
  DEFAULT_RUNTIME_READINESS_TIMEOUT_MS,
  RUNTIME_READINESS_DEADLINE_ERROR_NAME,
} from '../constants';
import type {
  DesktopRuntimeStatus,
  RuntimeReadinessPolling,
} from '../contracts';
import { ValidationEnvironmentService } from './validation-environment.service';

@Injectable({ providedIn: 'root' })
export class ValidationRuntimeReadinessService {
  private readonly environment = inject(ValidationEnvironmentService);

  waitUntilReady(): Observable<void> {
    const polling =
      this.environment.runtimeReadinessPolling ?? this.defaultPolling();
    const pollIntervalMs = this.finiteIntegerAtLeast(
      polling.pollIntervalMs,
      1,
    );
    const timeoutMs = this.finiteIntegerAtLeast(polling.timeoutMs, 0);
    const maximumPolls = Math.floor(timeoutMs / pollIntervalMs) + 1;
    const deadline = polling.now() + timeoutMs;

    const poll = (
      index: number,
      lastStatus?: DesktopRuntimeStatus,
    ): Observable<void> => {
      if (index >= maximumPolls || polling.now() >= deadline) {
        return throwError(
          () =>
            new Error(
              `Capture runtime did not become ready within ${timeoutMs} ms. Last status: ${lastStatus?.detail ?? 'unavailable'}`,
            ),
        );
      }

      return this.settleBeforeDeadline(
        defer(() => this.environment.loadDesktopRuntimeStatus()),
        deadline,
        polling,
      ).pipe(
        concatMap((status) => {
          if (polling.now() >= deadline) {
            return throwError(
              () =>
                new Error(
                  `Capture runtime did not become ready within ${timeoutMs} ms. Last status: ${status.detail}`,
                ),
            );
          }
          if (status.status === 'ready') return of(undefined);
          if (status.status === 'failed' || status.status === 'stopped') {
            return throwError(
              () => new Error(`Capture runtime ${status.status}: ${status.detail}`),
            );
          }
          if (status.status !== 'starting') {
            return throwError(
              () =>
                new Error(
                  `Capture runtime returned unsupported status "${status.status}": ${status.detail}`,
                ),
            );
          }
          if (index + 1 >= maximumPolls) return poll(index + 1, status);
          const remainingMs = deadline - polling.now();
          if (remainingMs <= 0) return poll(index + 1, status);
          return this.settleBeforeDeadline(
            polling.wait(Math.min(pollIntervalMs, remainingMs)),
            deadline,
            polling,
          ).pipe(concatMap(() => poll(index + 1, status)));
        }),
        catchError((error: unknown) => {
          if (this.isDeadlineError(error)) {
            return throwError(
              () =>
                new Error(
                  `Capture runtime did not become ready within ${timeoutMs} ms. Last status: unavailable`,
                ),
            );
          }
          return throwError(() => error);
        }),
      );
    };

    return defer(() => poll(0));
  }

  private settleBeforeDeadline<T>(
    operation: Observable<T>,
    deadline: number,
    polling: RuntimeReadinessPolling,
  ): Observable<T> {
    const remainingMs = deadline - polling.now();
    if (remainingMs <= 0) {
      return throwError(() => this.deadlineError());
    }

    return new Observable<T>((subscriber) => {
      let settled = false;
      let cancelTimeout = (): void => undefined;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        action();
      };

      cancelTimeout = polling.scheduleTimeout(
        () => finish(() => subscriber.error(this.deadlineError())),
        Math.ceil(remainingMs),
      );
      const subscription = operation.subscribe({
        next: (value) => finish(() => subscriber.next(value)),
        error: (error: unknown) => finish(() => subscriber.error(error)),
        complete: () => finish(() => subscriber.complete()),
      });

      return () => {
        cancelTimeout();
        subscription.unsubscribe();
      };
    });
  }

  private finiteIntegerAtLeast(value: number, minimum: number): number {
    if (!Number.isFinite(value)) return minimum;
    return Math.max(minimum, Math.trunc(value));
  }

  private deadlineError(): Error {
    const error = new Error(RUNTIME_READINESS_DEADLINE_ERROR_NAME);
    error.name = RUNTIME_READINESS_DEADLINE_ERROR_NAME;
    return error;
  }

  private isDeadlineError(error: unknown): boolean {
    return (
      error instanceof Error && error.name === RUNTIME_READINESS_DEADLINE_ERROR_NAME
    );
  }

  private defaultPolling(): RuntimeReadinessPolling {
    return {
      timeoutMs: DEFAULT_RUNTIME_READINESS_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_RUNTIME_READINESS_POLL_INTERVAL_MS,
      now: () => globalThis.performance?.now() ?? Date.now(),
      wait: (milliseconds) => timer(milliseconds).pipe(map(() => undefined)),
      scheduleTimeout: (callback, milliseconds) => {
        const handle = globalThis.setTimeout(callback, milliseconds);
        return () => globalThis.clearTimeout(handle);
      },
    };
  }
}
