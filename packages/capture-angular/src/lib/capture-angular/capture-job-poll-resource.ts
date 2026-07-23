import { rxResource } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  defer,
  of,
  ReplaySubject,
  throwError,
  timer,
  type Observable,
  catchError,
  expand,
  finalize,
  switchMap,
  tap,
} from 'rxjs';
import type { Injector } from '@angular/core';
import type { CaptureClient, CaptureJobV1 } from '../contracts';

export interface CaptureJobPollResourceOptions {
  readonly client: CaptureClient;
  readonly captureId: string;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly stopForHost: boolean;
  readonly injector: Injector;
  readonly onJob: (job: CaptureJobV1) => void;
}

export interface CaptureJobPollResource {
  readonly terminal$: Observable<CaptureJobV1>;
  readonly destroy: () => void;
}

/**
 * Owns only the repeated GET side of a capture job. Mutations remain with the
 * component's imperative workflow so their idempotency and reconciliation
 * semantics stay explicit.
 */
export function createCaptureJobPollResource(
  options: CaptureJobPollResourceOptions,
): CaptureJobPollResource {
  if (options.signal.aborted) {
    return {
      terminal$: throwError(() => createAbortError()),
      destroy: () => undefined,
    };
  }

  const terminalSubject = new ReplaySubject<CaptureJobV1>(1);
  let settled = false;
  let destroyResource: () => void = () => undefined;

  const jobResource = rxResource({
    injector: options.injector,
    params: () => options,
    stream: ({ params, abortSignal }) =>
      pollCaptureJobs(params, abortSignal).pipe(
        tap((job) => {
          if (options.signal.aborted || settled) return;
          options.onJob(job);
          if (!shouldContinuePolling(job, options.stopForHost)) {
            settled = true;
            terminalSubject.next(job);
            terminalSubject.complete();
          }
        }),
        catchError((error: unknown) => {
          if (!settled) {
            settled = true;
            terminalSubject.error(error);
          }
          return throwError(() => error);
        }),
        finalize(() => {
          if (!settled) {
            settled = true;
            terminalSubject.error(
              new Error('Capture polling ended before reaching a terminal state.'),
            );
          }
        }),
      ),
  });

  const destroy = (): void => {
    options.signal.removeEventListener('abort', destroy);
    if (!settled) {
      settled = true;
      terminalSubject.error(createAbortError());
    }
    destroyResource();
  };

  destroyResource = () => jobResource.destroy();
  options.signal.addEventListener('abort', destroy, { once: true });

  if (options.signal.aborted) destroy();

  return { terminal$: terminalSubject.asObservable(), destroy };
}

function pollCaptureJobs(
  options: CaptureJobPollResourceOptions,
  abortSignal: AbortSignal,
): Observable<CaptureJobV1> {
  const delay$: Observable<unknown> =
    options.pollIntervalMs > 0 ? timer(options.pollIntervalMs) : of(undefined);
  const read = () =>
    delay$.pipe(
      switchMap(() =>
        defer(() => options.client.getCapture(options.captureId, abortSignal)),
      ),
    );

  return read().pipe(
    expand((job: CaptureJobV1) =>
      shouldContinuePolling(job, options.stopForHost) ? read() : EMPTY,
    ),
  );
}

function shouldContinuePolling(
  job: CaptureJobV1,
  stopForHost: boolean,
): boolean {
  return (
    job.status === 'queued' ||
    (job.status === 'running' &&
      !(stopForHost && job.stage === 'awaiting_structuring'))
  );
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
