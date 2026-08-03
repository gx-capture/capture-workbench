import { EffectRef, Injectable, Injector, effect, inject } from '@angular/core';
import { catchError, defer, Observable, throwError } from 'rxjs';
import type {
  CaptureReviewV1,
  CaptureFailureV1,
  CaptureJobV1,
  RawCaptureV1,
  CaptureTaskView,
} from '../../../contracts';
import { HOST_RECONCILIATION_FAILURE_CODE } from '../../../constants';
import type { SettledResource } from './internal-contracts';

export function isTerminalTask(task: CaptureTaskView): boolean {
  return (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'canceled'
  );
}

export function isTerminalCaptureJob(job: CaptureJobV1): boolean {
  return (
    job.status === 'completed' ||
    job.status === 'failed' ||
    job.status === 'cancelled'
  );
}

export function isAwaitingHostStructuring(job: CaptureJobV1): boolean {
  return (
    job.status === 'running' &&
    job.stage === 'awaiting_structuring' &&
    job.structuringMode === 'host'
  );
}

export function validateCaptureReview(
  raw: RawCaptureV1,
  review: CaptureReviewV1,
): string[] {
  if (review.reviewVersion !== 1) return ['reviewVersion must be 1'];
  const segmentsById = new Map(
    raw.segments.map((segment) => [segment.segmentId, segment]),
  );
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const edit of review.edits) {
    if (seen.has(edit.segmentId)) {
      issues.push(`duplicate segmentId ${edit.segmentId}`);
      continue;
    }
    seen.add(edit.segmentId);
    const segment = segmentsById.get(edit.segmentId);
    if (!segment) {
      issues.push(`unknown segmentId ${edit.segmentId}`);
      continue;
    }
    if (edit.reviewedText.trim().length === 0) {
      issues.push(`reviewedText for ${edit.segmentId} must not be empty`);
    }
  }
  return issues;
}

export function normalizeHostFailureMessage(message: string): string {
  const normalized = redactSensitiveMessage(message).trim();
  return (normalized || 'Host structuring failed.').slice(0, 500);
}

export function hostReconciliationFailure(error: unknown): CaptureFailureV1 {
  return {
    code: HOST_RECONCILIATION_FAILURE_CODE,
    message: errorMessage(
      error,
      'Host structuring failed and the runtime terminal state could not be confirmed.',
    ),
    stage: 'structuring',
    retryable: true,
  };
}

export class HostReconciliationUnavailableError extends Error {
  constructor() {
    super(
      'Host structuring failed and the runtime terminal state could not be confirmed.',
    );
    this.name = 'HostReconciliationUnavailableError';
  }
}

export function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

export function runtimeProgressPercent(progress: number): number {
  return clampProgress(progress <= 1 ? progress * 100 : progress);
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? redactSensitiveMessage(error.message)
    : fallback;
}

export function failureFrom(
  error: unknown,
  stage: CaptureFailureV1['stage'],
  fallback: string,
): CaptureFailureV1 {
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  return {
    code:
      typeof candidate?.code === 'string'
        ? redactSensitiveMessage(candidate.code)
        : 'capture_failed',
    message:
      typeof candidate?.message === 'string'
        ? redactSensitiveMessage(candidate.message)
        : fallback,
    stage,
  };
}

export function redactFailure(error: CaptureFailureV1): CaptureFailureV1 {
  return {
    ...error,
    code: redactSensitiveMessage(error.code),
    message: redactSensitiveMessage(error.message),
  };
}

export function redactSensitiveMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(?:authorization|bearerToken|access_token|token)\s*[:=]\s*["']?[^"'\s,;}]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)} [redacted]`,
    );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted.', 'AbortError');
}

export function waitForResourceSettlement(
  resource: SettledResource,
  injector: Injector,
  lifecycleSignal: AbortSignal,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    if (lifecycleSignal.aborted) {
      subscriber.next();
      subscriber.complete();
      return;
    }
    let settled = false;
    let sawLoading = resource.isLoading();
    const effectRefHolder: { current?: EffectRef } = {};
    const finish = (): void => {
      if (settled) return;
      settled = true;
      lifecycleSignal.removeEventListener('abort', finish);
      effectRefHolder.current?.destroy();
      subscriber.next();
      subscriber.complete();
    };

    lifecycleSignal.addEventListener('abort', finish, { once: true });
    const effectRef = effect(
      () => {
        if (resource.isLoading()) {
          sawLoading = true;
          return;
        }
        if (sawLoading) finish();
      },
      { injector },
    );
    effectRefHolder.current = effectRef;

    return () => {
      lifecycleSignal.removeEventListener('abort', finish);
      effectRefHolder.current?.destroy();
    };
  });
}

export function retryUncertainResponse<T>(
  operation: () => Observable<T>,
  signal: AbortSignal,
): Observable<T> {
  return defer(operation).pipe(
    catchError((error: unknown) => {
      throwIfAborted(signal);
      return isUncertainResponseFailure(error)
        ? defer(operation)
        : throwError(() => error);
    }),
  );
}

export function isUncertainResponseFailure(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const candidate = error as {
    readonly status?: unknown;
    readonly code?: unknown;
  };
  if (candidate?.code === 'invalid_response') return true;
  if (typeof candidate?.status === 'number') {
    return candidate.status === 0 || candidate.status >= 500;
  }
  // Fetch surfaces network failures as TypeError. A plain Error from a custom
  // host client may be a definite domain failure and must not be replayed.
  return error instanceof TypeError;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

export function withoutExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/** Injectable owner for workflow and store support operations. */
@Injectable({ providedIn: 'root' })
export class CaptureWorkbenchStoreHelpers {
  private readonly injector = inject(Injector);

  isTerminalTask(task: CaptureTaskView): boolean {
    return isTerminalTask(task);
  }

  isTerminalCaptureJob(job: CaptureJobV1): boolean {
    return isTerminalCaptureJob(job);
  }

  isAwaitingHostStructuring(job: CaptureJobV1): boolean {
    return isAwaitingHostStructuring(job);
  }

  validateCaptureReview(raw: RawCaptureV1, review: CaptureReviewV1): string[] {
    return validateCaptureReview(raw, review);
  }

  normalizeHostFailureMessage(message: string): string {
    return normalizeHostFailureMessage(message);
  }

  hostReconciliationFailure(error: unknown): CaptureFailureV1 {
    return hostReconciliationFailure(error);
  }

  clampProgress(progress: number): number {
    return clampProgress(progress);
  }

  runtimeProgressPercent(progress: number): number {
    return runtimeProgressPercent(progress);
  }

  errorMessage(error: unknown, fallback: string): string {
    return errorMessage(error, fallback);
  }

  redactSensitiveMessage(message: string): string {
    return redactSensitiveMessage(message);
  }

  failureFrom(
    error: unknown,
    stage: CaptureFailureV1['stage'],
    fallback: string,
  ): CaptureFailureV1 {
    return failureFrom(error, stage, fallback);
  }

  redactFailure(error: CaptureFailureV1): CaptureFailureV1 {
    return redactFailure(error);
  }

  isAbortError(error: unknown): boolean {
    return isAbortError(error);
  }

  throwIfAborted(signal: AbortSignal): void {
    return throwIfAborted(signal);
  }

  waitForResourceSettlement(
    resource: SettledResource,
    lifecycleSignal: AbortSignal,
  ): Observable<void> {
    return waitForResourceSettlement(resource, this.injector, lifecycleSignal);
  }

  retryUncertainResponse<T>(
    operation: () => Observable<T>,
    signal: AbortSignal,
  ): Observable<T> {
    return retryUncertainResponse(operation, signal);
  }

  isUncertainResponseFailure(error: unknown): boolean {
    return isUncertainResponseFailure(error);
  }

  deepFreeze<T>(value: T): T {
    return deepFreeze(value);
  }

  withoutExtension(fileName: string): string {
    return withoutExtension(fileName);
  }
}
