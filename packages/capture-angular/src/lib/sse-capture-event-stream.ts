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
  /** Binds every decoded event to the capture requested by the host. */
  readonly expectedCaptureId?: string;
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
const MAX_SSE_LINE_BYTES = 64 * 1024;
const MAX_SSE_FRAME_LINES = 1024;

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
    const initialSequence = parseEventCursor(init.lastEventId);
    return from(
      fetchImplementation(input, {
        ...init,
        headers,
        signal: controller.signal,
      }),
    ).pipe(
      mergeMap((response) =>
        response.ok
          ? eventStreamFromResponse(
            response,
            init.expectedCaptureId,
            initialSequence,
          )
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

export function decodeCaptureEventFrame(
  frame: SseEventFrame,
  expectedCaptureId?: string,
): CaptureEventV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    throw invalidEventFrame();
  }
  const event = normalizeCaptureEvent(parsed, expectedCaptureId);
  if (
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
  expectedCaptureId: string | undefined,
  initialSequence: number | undefined,
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
  return eventStreamFromBody(response.body, expectedCaptureId, initialSequence);
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
  expectedCaptureId: string | undefined,
  initialSequence: number | undefined,
): Observable<CaptureEventV2> {
  return defer(() => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseCaptureEventParser();
    let previousSequence = initialSequence;
    const decode = (frame: SseEventFrame): CaptureEventV2 => {
      const event = decodeCaptureEventFrame(frame, expectedCaptureId);
      if (previousSequence !== undefined && event.sequence <= previousSequence) {
        throw invalidEventFrame();
      }
      previousSequence = event.sequence;
      return event;
    };
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
        const events = frames.map(decode);
        return done
          ? concat(
              from(events),
              from(parser.finish().map(decode)),
            )
          : from(events);
      }),
    );
  });
}

class SseCaptureEventParser {
  private line = '';
  private block: string[] = [];
  private pendingCarriageReturn = false;

  push(chunk: string): readonly SseEventFrame[] {
    const frames: SseEventFrame[] = [];
    let index = 0;
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      if (chunk[index] === '\n') index += 1;
      this.emitLine(frames);
    }
    while (index < chunk.length) {
      const character = chunk[index];
      index += 1;
      if (character === '\r') {
        if (index === chunk.length) {
          this.pendingCarriageReturn = true;
        } else {
          if (chunk[index] === '\n') index += 1;
          this.emitLine(frames);
        }
      } else if (character === '\n') {
        this.emitLine(frames);
      } else {
        this.line += character;
        if (this.line.length > MAX_SSE_LINE_BYTES) throw invalidEventFrame();
      }
    }
    return frames;
  }

  finish(): readonly SseEventFrame[] {
    const pending = this.pendingCarriageReturn || this.line !== '' || this.block.length > 0;
    this.line = '';
    this.block = [];
    this.pendingCarriageReturn = false;
    if (pending) throw invalidEventFrame();
    return [];
  }

  private emitLine(frames: SseEventFrame[]): void {
    if (this.line === '') {
      const frame = parseSseBlock(this.block.join('\n'));
      if (frame) frames.push(frame);
      this.block = [];
    } else {
      if (this.block.length >= MAX_SSE_FRAME_LINES) throw invalidEventFrame();
      this.block.push(this.line);
    }
    this.line = '';
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
      if (!value) throw invalidEventFrame();
      id = value;
    } else if (field === 'event') {
      if (value) event = value;
    }
  }
  if (data.length === 0) return undefined;
  return { id, event, data: data.join('\n') };
}

function normalizeCaptureEvent(
  value: unknown,
  expectedCaptureId?: string,
): CaptureEventV2 {
  if (!value || typeof value !== 'object') throw invalidEventFrame();
  const event = value as Record<string, unknown>;
  const isNonEmptyString = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && candidate !== '';
  const allowedFields = new Set([
    'protocolVersion',
    'eventId',
    'sequence',
    'captureId',
    'kind',
    'eventType',
    'stage',
    'progress',
    'partialRevision',
    'coveredUntilMs',
    'segments',
    'error',
    'createdAt',
  ]);
  if (
    Object.keys(event).some((key) => !allowedFields.has(key)) ||
    event['protocolVersion'] !== '2' ||
    !isNonEmptyString(event['eventId']) ||
    typeof event['sequence'] !== 'number' ||
    !Number.isSafeInteger(event['sequence']) ||
    event['sequence'] < 0 ||
    !isNonEmptyString(event['captureId']) ||
    (expectedCaptureId !== undefined && event['captureId'] !== expectedCaptureId) ||
    event['eventId'] !== `${event['captureId']}/${event['sequence']}` ||
    !isNonEmptyString(event['kind']) ||
    !['pdf', 'image', 'audio'].includes(event['kind']) ||
    !isNonEmptyString(event['eventType']) ||
    !STREAMING_EVENT_TYPES.has(event['eventType']) ||
    !isNonEmptyString(event['stage']) ||
    !isNonEmptyString(event['createdAt']) ||
    !validRfc3339Timestamp(event['createdAt'])
  ) {
    throw invalidEventFrame();
  }
  const progress = event['progress'];
  if (
    progress !== undefined &&
    progress !== null &&
    (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)
  ) {
    throw invalidEventFrame();
  }
  for (const field of ['partialRevision', 'coveredUntilMs'] as const) {
    const candidate = event[field];
    if (
      candidate !== undefined &&
      candidate !== null &&
      (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0)
    ) {
      throw invalidEventFrame();
    }
  }
  const segments = event['segments'];
  if (
    segments !== undefined &&
    segments !== null &&
    !Array.isArray(segments)
  ) {
    throw invalidEventFrame();
  }
  if (event['eventType'] === 'segment') {
    if (!Array.isArray(segments) || segments.length === 0) throw invalidEventFrame();
  }
  if (Array.isArray(segments)) {
    segments.forEach(validateCaptureSegment);
  }
  const error = event['error'];
  if (event['eventType'] === 'failed') {
    if (!isRecord(error)) throw invalidEventFrame();
    validateCaptureFailure(error);
  } else if (error !== undefined && error !== null) {
    throw invalidEventFrame();
  }
  return {
    ...(event as unknown as Omit<CaptureEventV2, 'protocolVersion'>),
    protocolVersion: '2' as const,
  };
}

function validateCaptureSegment(value: unknown): void {
  if (!isRecord(value)) throw invalidEventFrame();
  if (
    Object.keys(value).some((key) => !['segmentId', 'order', 'locator', 'text'].includes(key)) ||
    typeof value['segmentId'] !== 'string' ||
    value['segmentId'] === '' ||
    typeof value['order'] !== 'number' ||
    !Number.isSafeInteger(value['order']) ||
    value['order'] < 0 ||
    typeof value['text'] !== 'string' ||
    value['text'] === '' ||
    [...value['text']].length > 2_000_000
  ) {
    throw invalidEventFrame();
  }
  if (!isRecord(value['locator'])) throw invalidEventFrame();
  const locator = value['locator'];
  if (locator['kind'] === 'page') {
    if (
      Object.keys(locator).some((key) => !['kind', 'page', 'boundingBox'].includes(key)) ||
      typeof locator['page'] !== 'number' ||
      !Number.isSafeInteger(locator['page']) ||
      locator['page'] < 1 ||
      (locator['boundingBox'] !== undefined &&
        locator['boundingBox'] !== null &&
        (!Array.isArray(locator['boundingBox']) ||
          locator['boundingBox'].length !== 4 ||
          locator['boundingBox'].some(
            (item) => typeof item !== 'number' || !Number.isFinite(item),
          )))
    ) {
      throw invalidEventFrame();
    }
    return;
  }
  if (
    locator['kind'] !== 'time' ||
    Object.keys(locator).some((key) => !['kind', 'startMs', 'endMs'].includes(key)) ||
    typeof locator['startMs'] !== 'number' ||
    !Number.isSafeInteger(locator['startMs']) ||
    locator['startMs'] < 0 ||
    typeof locator['endMs'] !== 'number' ||
    !Number.isSafeInteger(locator['endMs']) ||
    locator['endMs'] <= locator['startMs']
  ) {
    throw invalidEventFrame();
  }
}

function validateCaptureFailure(value: Record<string, unknown>): void {
  const code = value['code'];
  const message = value['message'];
  if (
    Object.keys(value).some((key) => !['code', 'message', 'stage', 'retryable'].includes(key)) ||
    typeof code !== 'string' ||
    !/^[a-z][a-z0-9_]{1,63}$/u.test(code) ||
    typeof message !== 'string' ||
    message === '' ||
    [...message].length > 500 ||
    (value['stage'] !== undefined &&
      value['stage'] !== null &&
      (typeof value['stage'] !== 'string' || value['stage'] === '')) ||
    (value['retryable'] !== undefined && typeof value['retryable'] !== 'boolean')
  ) {
    throw invalidEventFrame();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEventCursor(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  if (!/^-?\d+$/u.test(text)) throw invalidEventCursor();
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor) || cursor < -1) throw invalidEventCursor();
  return cursor;
}

function validRfc3339Timestamp(value: string): boolean {
  const match = /^(?<date>\d{4}-\d{2}-\d{2})T(?<clock>\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?<zone>Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match?.groups) return false;
  const date = match.groups['date'];
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const clock = match.groups['clock'];
  const [hours, minutes, seconds] = clock.split(':').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hours > 23 || minutes > 59 || seconds > 60) return false;
  if (match.groups['zone'] !== 'Z') {
    const offset = match.groups['zone'].slice(1).split(':').map(Number);
    if (offset[0] > 23 || offset[1] > 59) return false;
  }
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function invalidEventFrame(): CaptureHttpError {
  return new CaptureHttpError(
    0,
    'invalid_event_frame',
    'Capture runtime sent an invalid SSE event.',
  );
}

function invalidEventCursor(): CaptureHttpError {
  return new CaptureHttpError(
    0,
    'invalid_event_cursor',
    'Capture runtime event cursor is invalid.',
  );
}
