import { Observable, catchError, defer, throwError } from 'rxjs';
import type { CaptureFailure } from './contracts';

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? redactSensitiveMessage(error.message)
    : fallback;
}

export function redactFailure(error: CaptureFailure): CaptureFailure {
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
