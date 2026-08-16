export interface CaptureRuntimeErrorMetadata {
  readonly category?: string;
  readonly retryable?: boolean;
  readonly issues?: readonly Record<string, unknown>[];
  readonly requestId?: string;
}

export class CaptureRuntimeError extends Error {
  readonly details?: unknown;
  readonly statusCode: number;
  readonly category: string;
  readonly retryable: boolean;
  readonly issues: readonly Record<string, unknown>[];
  readonly requestId?: string;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    details?: unknown,
    metadata: CaptureRuntimeErrorMetadata = {},
  ) {
    super(redact(message));
    this.name = 'CaptureRuntimeError';
    this.details = redactValue(details);
    this.statusCode = status;
    this.category = metadata.category ?? 'runtime';
    this.retryable = metadata.retryable ?? false;
    this.issues = (metadata.issues ?? []).map((issue) => redactValue(issue) as Record<string, unknown>);
    this.requestId = metadata.requestId;
  }
}

export class CaptureTransportError extends CaptureRuntimeError {
  constructor(message: string, details?: unknown, code = 'transport_error') {
    super(0, code, message, details, { category: 'transport', retryable: true });
    this.name = 'CaptureTransportError';
  }
}

export class CaptureAuthenticationError extends CaptureRuntimeError {
  constructor(message = 'Capture Runtime authentication failed.', status = 401, details?: unknown, requestId?: string) {
    super(status, 'unauthorized', message, details, { category: 'authentication', requestId });
    this.name = 'CaptureAuthenticationError';
  }
}

export class CaptureCompatibilityError extends CaptureRuntimeError {
  constructor(message: string, details?: unknown) {
    super(0, 'incompatible_runtime', message, details, { category: 'compatibility' });
    this.name = 'CaptureCompatibilityError';
  }
}

export class CaptureProtocolError extends CaptureRuntimeError {
  constructor(message: string, details?: unknown) {
    super(0, 'protocol_error', message, details, { category: 'protocol' });
    this.name = 'CaptureProtocolError';
  }
}

export class CaptureRemoteError extends CaptureRuntimeError {
  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    metadata: CaptureRuntimeErrorMetadata = {},
  ) {
    super(status, code, message, details, {
      ...metadata,
      category: metadata.category ?? 'remote',
    });
    this.name = 'CaptureRemoteError';
  }
}

/** Compatibility names retained for consumers of the initial SDK preview. */
export class CaptureRuntimeProtocolError extends CaptureProtocolError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'CaptureRuntimeProtocolError';
  }
}

export class CaptureRuntimeCompatibilityError extends CaptureCompatibilityError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'CaptureRuntimeCompatibilityError';
  }
}

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/(?:authorization|bearerToken|access_token|token)\s*[:=]\s*['"]?[^'"\s,;}]+/giu, (match) => {
      const separator = match.search(/[:=]/u);
      return `${match.slice(0, separator + 1)} [redacted]`;
    });
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null || typeof value !== 'object') {
    return typeof value === 'string' ? redact(value) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = /token|authorization|credential|secret|password/iu.test(key)
      ? '[redacted]'
      : redactValue(entry, depth + 1);
  }
  return output;
}
