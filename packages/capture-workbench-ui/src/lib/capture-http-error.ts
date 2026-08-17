import type { CaptureFailure } from './contracts';
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

  asFailure(stage?: CaptureFailure['stage']): CaptureFailure {
    return { code: this.code, message: this.message, stage };
  }
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
