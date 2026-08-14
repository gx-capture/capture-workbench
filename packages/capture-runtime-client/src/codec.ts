import {
  CaptureAuthenticationError,
  CaptureRemoteError,
  CaptureRuntimeError,
  CaptureRuntimeProtocolError,
} from './errors.js';
import type { ErrorEnvelope, RuntimeTransport } from './contracts.js';

/** Generated wire models whose top-level fields are checked before casting. */
export type RuntimeResponseModel =
  | 'RuntimeReady'
  | 'RuntimeStreamingCapabilities'
  | 'RuntimeRequirements'
  | 'RuntimeInstallation'
  | 'RuntimeInstallations'
  | 'RuntimeModelInstallation'
  | 'RuntimeModelOptions'
  | 'RawCapture'
  | 'CaptureDocument'
  | 'CaptureOperation'
  | 'Ingestion'
  | 'PartialCapture'
  | 'StreamingResult';

const MODEL_FIELDS: Record<RuntimeResponseModel, { readonly required: readonly string[]; readonly optional: readonly string[] }> = {
  RuntimeReady: { required: ['ready', 'service', 'apiVersion', 'runtimeVersion', 'captureDocumentSchemaVersion', 'capabilities'], optional: ['message', 'captureDocumentSchemaSha256', 'schemaSha256', 'contractSetVersion'] },
  RuntimeStreamingCapabilities: { required: ['protocolVersion', 'maxChunkBytes', 'checkpointIntervalMs', 'heartbeatIntervalMs', 'stallTimeoutMs'], optional: ['captureKinds', 'supportsProgressiveAudio'] },
  RuntimeRequirements: { required: ['items'], optional: [] },
  RuntimeInstallation: { required: ['installationId', 'requirementId', 'status', 'progress', 'createdAt', 'updatedAt'], optional: ['error', 'completedAt'] },
  RuntimeInstallations: { required: ['items'], optional: [] },
  RuntimeModelInstallation: { required: ['installationId', 'optionId', 'status', 'progress', 'createdAt', 'updatedAt'], optional: ['error', 'completedAt'] },
  RuntimeModelOptions: { required: ['catalogSha256', 'items'], optional: [] },
  RawCapture: { required: ['schemaVersion', 'diagnosticOnly', 'source', 'segments', 'sourceText', 'extractionEngine', 'createdAt'], optional: ['warnings'] },
  CaptureDocument: { required: ['blocks', 'completedAt', 'createdAt', 'extractionEngine', 'rawSegments', 'schemaVersion', 'source', 'sourceText', 'structuringEngine', 'targetText'], optional: ['warnings'] },
  CaptureOperation: { required: ['protocolVersion', 'captureId', 'ingestionId', 'status', 'partialRevision', 'lastEventSequence', 'createdAt', 'updatedAt'], optional: ['kind', 'progress', 'source', 'error', 'completedAt'] },
  Ingestion: { required: ['protocolVersion', 'ingestionId', 'status', 'fileName', 'mediaType', 'totalBytes', 'receivedBytes', 'contiguousBytes', 'nextChunkIndex', 'nextOffset', 'expiresAt'], optional: ['kind', 'sourceSha256', 'finalizedSha256'] },
  PartialCapture: { required: ['protocolVersion', 'captureId', 'source', 'revision', 'coveredUntilMs', 'updatedAt'], optional: ['segments', 'sourceText', 'extractionEngine'] },
  StreamingResult: { required: ['operation', 'raw', 'result'], optional: [] },
};

export async function decodeJson<T>(response: Response, transport?: RuntimeTransport, model?: RuntimeResponseModel): Promise<T> {
  if (!response.ok) throw await decodeError(response);
  if (response.status === 204) return undefined as T;
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid JSON.', error);
  }
  if (value === undefined) throw new CaptureRuntimeProtocolError('Capture Runtime returned an empty response.');
  if (model) validateModelShape(value, model);
  return value as T;
}

function validateModelShape(value: unknown, model: RuntimeResponseModel): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${model} data.`);
  }
  const record = value as Record<string, unknown>;
  const fields = MODEL_FIELDS[model];
  const allowed = new Set([...fields.required, ...fields.optional]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned unknown ${model} field: ${unknown}.`);
  }
  const missing = fields.required.find((key) => !(key in record));
  if (missing) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned ${model} without required field: ${missing}.`);
  }
}

export async function decodeError(response: Response): Promise<CaptureRuntimeError> {
  let envelope: ErrorEnvelope | undefined;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // Keep a stable error shape when a proxy returns HTML or an empty body.
  }
  const error = envelope?.error as (ErrorEnvelope['error'] & {
    readonly category?: unknown;
    readonly retryable?: unknown;
    readonly issues?: unknown;
    readonly requestId?: unknown;
  }) | undefined;
  const details = error?.details;
  const detailsMap = details && typeof details === 'object' ? details as Record<string, unknown> : {};
  const category = typeof error?.category === 'string'
    ? error.category
    : typeof detailsMap['category'] === 'string' ? detailsMap['category'] : undefined;
  const retryable = typeof error?.retryable === 'boolean'
    ? error.retryable
    : typeof detailsMap['retryable'] === 'boolean' ? detailsMap['retryable'] : response.status >= 500;
  const issues = Array.isArray(error?.issues)
    ? error.issues.filter((issue): issue is Record<string, unknown> => !!issue && typeof issue === 'object')
    : Array.isArray(detailsMap['issues'])
      ? detailsMap['issues'].filter((issue): issue is Record<string, unknown> => !!issue && typeof issue === 'object')
      : undefined;
  const requestId = response.headers.get('x-request-id')
    ?? response.headers.get('x-correlation-id')
    ?? (typeof error?.requestId === 'string' ? error.requestId : typeof detailsMap['requestId'] === 'string' ? detailsMap['requestId'] as string : undefined);
  const status = response.status;
  const code = error?.code ?? `http_${status}`;
  const message = error?.message ?? `Capture Runtime request failed (${status}).`;
  if (status === 401 || status === 403 || code === 'unauthorized' || code === 'authentication_failed') {
    return new CaptureAuthenticationError(message, status, details, requestId);
  }
  return new CaptureRemoteError(status, code, message, details, { category, retryable, issues, requestId });
}

export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

/** Parse a complete SSE response while retaining protocol bounds. */
export async function* decodeSse(response: Response): AsyncGenerator<SseFrame> {
  if (!response.ok) throw await decodeError(response);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('text/event-stream')) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned an invalid event stream.');
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frame: { id?: string; event?: string; data: string[] } = { data: [] };
  const flush = (): SseFrame | undefined => {
    if (frame.data.length === 0) {
      frame = { data: [] };
      return undefined;
    }
    const result: SseFrame = { id: frame.id, event: frame.event, data: frame.data.join('\n') };
    frame = { data: [] };
    return result;
  };
  while (true) {
    const next = await reader.read();
    buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const result = flush();
        if (result) yield result;
      } else if (line.startsWith(':')) {
        // Heartbeat comments intentionally do not produce a client event.
      } else {
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
        if (field === 'id') frame.id = value;
        else if (field === 'event') frame.event = value;
        else if (field === 'data') frame.data.push(value);
      }
      newline = buffer.indexOf('\n');
    }
    if (next.done) break;
  }
  if (buffer) {
    const line = buffer.replace(/\r$/u, '');
    if (line.startsWith('data:')) frame.data.push(line.slice(5).replace(/^ /u, ''));
  }
  const result = flush();
  if (result) yield result;
}

export function parseJsonFrame<T>(frame: SseFrame, label = 'event'): T {
  try {
    return JSON.parse(frame.data) as T;
  } catch (error) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${label} JSON.`, error);
  }
}
