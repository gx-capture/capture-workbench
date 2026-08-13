import { catchError, from, map, of, type Observable } from 'rxjs';
import type { CaptureFailureV1 } from './contracts';

export interface ErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: unknown;
  };
}
export class CaptureHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    details?: unknown,
  ) {
    super(redactSensitiveMessage(message));
    this.name = 'CaptureHttpError';
    this.details = redactSensitiveValue(details);
  }

  readonly details?: unknown;

  asFailure(stage?: CaptureFailureV1['stage']): CaptureFailureV1 {
    return { code: this.code, message: this.message, stage };
  }
}

export function readJson<T>(response: Response): Observable<T | undefined> {
  return from(response.json()).pipe(
    map((value) => value as T),
    catchError(() => of(undefined)),
  );
}

export function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function redactSensitiveMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(?:authorization|bearerToken|access_token|token)\s*[:=]\s*["']?[^"'\s,;}]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)} [redacted]`,
    );
}

function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitiveMessage(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry, depth + 1));
  }
  if (typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:token|authorization|credential|secret|password)/iu.test(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactSensitiveValue(entry, depth + 1);
    }
  }
  return result;
}
