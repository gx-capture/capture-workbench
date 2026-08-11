import {
  EMPTY,
  concat,
  defer,
  expand,
  finalize,
  from,
  map,
  mergeMap,
  throwError,
  type Observable,
} from 'rxjs';
import {
  CaptureHttpError,
  createAbortError,
  readJson,
  type ErrorEnvelope,
} from './capture-http-error';
import type { CaptureEventV2 } from './contracts';

export interface SseEventFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

export interface CaptureEventStreamInit extends RequestInit {
  /** Resumes replay after this SSE event sequence/id. */
  readonly lastEventId?: string | number;
}

const STREAMING_EVENT_TYPES = new Set([
  'accepted',
  'input_checkpoint',
  'heartbeat',
  'segment',
  'checkpoint',
  'resync_required',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Cold, authenticated fetch + ReadableStream SSE parser. Every subscription
 * starts a fresh request, and unsubscribing aborts that request. Native
 * EventSource is intentionally not used because the runtime requires an
 * Authorization header.
 */
export function captureEventStream(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: CaptureEventStreamInit = {},
): Observable<CaptureEventV2> {
  return defer(() => {
    const controller = new AbortController();
    const externalSignal = init.signal ?? null;
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) return throwError(() => createAbortError());
    externalSignal?.addEventListener('abort', abort, { once: true });
    const headers = new Headers(init.headers);
    if (init.lastEventId !== undefined) {
      headers.set('Last-Event-ID', String(init.lastEventId));
    }
    return from(
      fetchImplementation(input, {
        ...init,
        headers,
        signal: controller.signal,
      }),
    ).pipe(
      mergeMap((response) =>
        response.ok
          ? eventStreamFromResponse(response)
          : errorFromResponse(response),
      ),
      finalize(() => {
        externalSignal?.removeEventListener('abort', abort);
        controller.abort();
      }),
    );
  });
}

export function parseSseText(text: string): readonly SseEventFrame[] {
  const parser = new SseCaptureEventParser();
  return [...parser.push(text), ...parser.finish()];
}

export function decodeCaptureEventFrame(frame: SseEventFrame): CaptureEventV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    throw invalidEventFrame();
  }
  const event = normalizeCaptureEvent(parsed);
  if (
    frame.id !== undefined &&
    frame.id !== String(event.sequence)
  ) {
    throw invalidEventFrame();
  }
  if (
    frame.event !== undefined &&
    frame.event !== event.eventType
  ) {
    throw invalidEventFrame();
  }
  return event;
}

function eventStreamFromResponse(
  response: Response,
): Observable<CaptureEventV2> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('text/event-stream')) {
    return throwError(
      () =>
        new CaptureHttpError(
          response.status,
          'invalid_event_stream',
          'Capture runtime event response must be text/event-stream.',
        ),
    );
  }
  if (!response.body) {
    return throwError(
      () =>
        new CaptureHttpError(
          response.status,
          'invalid_event_stream',
          'Capture runtime event response has no body.',
        ),
    );
  }
  return eventStreamFromBody(response.body);
}

function errorFromResponse(response: Response): Observable<never> {
  return readJson<ErrorEnvelope>(response).pipe(
    mergeMap((envelope) =>
      throwError(
        () =>
          new CaptureHttpError(
            response.status,
            envelope?.error?.code ?? `http_${response.status}`,
            envelope?.error?.message ??
              `Capture runtime request failed (${response.status}).`,
            envelope?.error?.details,
          ),
      ),
    ),
  );
}

function eventStreamFromBody(
  body: ReadableStream<Uint8Array>,
): Observable<CaptureEventV2> {
  return defer(() => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseCaptureEventParser();
    const readChunk = () =>
      from(reader.read()).pipe(
        map(({ done, value }) => ({ done, value })),
      );
    return readChunk().pipe(
      expand(({ done }) => (done ? EMPTY : readChunk())),
      mergeMap(({ done, value }) => {
        const frames = parser.push(
          done ? decoder.decode() : decoder.decode(value, { stream: true }),
        );
        const events = frames.map(decodeCaptureEventFrame);
        return done
          ? concat(
              from(events),
              from(parser.finish().map(decodeCaptureEventFrame)),
            )
          : from(events);
      }),
    );
  });
}

class SseCaptureEventParser {
  private buffer = '';

  push(chunk: string): readonly SseEventFrame[] {
    this.buffer += chunk.replace(/\r\n?/gu, '\n');
    const frames: SseEventFrame[] = [];
    let separator = this.buffer.indexOf('\n\n');
    while (separator !== -1) {
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const frame = parseSseBlock(block);
      if (frame) frames.push(frame);
      separator = this.buffer.indexOf('\n\n');
    }
    return frames;
  }

  finish(): readonly SseEventFrame[] {
    if (!this.buffer) return [];
    const frame = parseSseBlock(this.buffer);
    this.buffer = '';
    return frame ? [frame] : [];
  }
}

function parseSseBlock(block: string): SseEventFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of block.split('\n')) {
    if (rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    if (colon === -1) continue;
    const field = rawLine.slice(0, colon);
    const value = rawLine.slice(colon + 1).replace(/^ /u, '');
    if (field === 'data') data.push(value);
    else if (field === 'id') {
      if (value) id = value;
    } else if (field === 'event') {
      if (value) event = value;
    }
  }
  if (data.length === 0) return undefined;
  return { id, event, data: data.join('\n') };
}

function normalizeCaptureEvent(value: unknown): CaptureEventV2 {
  if (!value || typeof value !== 'object') throw invalidEventFrame();
  const event = value as Record<string, unknown>;
  const isNonEmptyString = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && candidate !== '';
  if (
    !isNonEmptyString(event['eventId']) ||
    typeof event['sequence'] !== 'number' ||
    !Number.isInteger(event['sequence']) ||
    event['sequence'] < 0 ||
    !isNonEmptyString(event['captureId']) ||
    !isNonEmptyString(event['eventType']) ||
    !STREAMING_EVENT_TYPES.has(event['eventType']) ||
    !isNonEmptyString(event['stage']) ||
    !isNonEmptyString(event['createdAt'])
  ) {
    throw invalidEventFrame();
  }
  if (
    event['protocolVersion'] !== undefined &&
    event['protocolVersion'] !== '2'
  ) {
    throw invalidEventFrame();
  }
  if (
    event['kind'] !== undefined &&
    event['kind'] !== 'pdf' &&
    event['kind'] !== 'image' &&
    event['kind'] !== 'audio'
  ) {
    throw invalidEventFrame();
  }
  return {
    ...(event as unknown as Omit<CaptureEventV2, 'protocolVersion'>),
    protocolVersion: '2' as const,
  };
}

function invalidEventFrame(): CaptureHttpError {
  return new CaptureHttpError(
    0,
    'invalid_event_frame',
    'Capture runtime sent an invalid SSE event.',
  );
}
