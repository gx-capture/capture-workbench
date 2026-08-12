import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readJsonObject,
  sanitizeProbeError,
  UserPdfOcrProbeError,
  waitForExtraction,
} from './user-pdf-ocr-probe.mts';

const SECRET = 'user-pdf-bearer-secret';
const CAPTURE_ID = 'capture-probe-1';

function eventFrame(
  sequence: number,
  eventType: string,
  stage: string,
  options: { readonly eventId?: string; readonly multiline?: boolean } = {},
): string {
  const payload = JSON.stringify({
    protocolVersion: '2',
    eventId: options.eventId ?? `${CAPTURE_ID}/${sequence}`,
    sequence,
    captureId: CAPTURE_ID,
    kind: 'pdf',
    eventType,
    stage,
    progress: eventType === 'completed' ? 1 : 0.5,
    createdAt: '2026-08-12T00:00:00Z',
  });
  if (options.multiline) {
    const split = payload.indexOf(',"sequence"');
    return `id: ${sequence}\r\nevent: ${eventType}\r\ndata: ${payload.slice(0, split)}\r\ndata:${payload.slice(split)}\r\n\r\n`;
  }
  return `id: ${sequence}\r\nevent: ${eventType}\r\ndata: ${payload}\r\n\r\n`;
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function chunkedSseResponse(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}

function snapshotResponse(
  status: string,
  lastEventSequence: number,
): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: '2',
      captureId: CAPTURE_ID,
      ingestionId: 'ingestion-probe-1',
      status,
      progress: 0.5,
      partialRevision: 1,
      lastEventSequence,
      createdAt: '2026-08-12T00:00:00Z',
      updatedAt: '2026-08-12T00:00:00Z',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('probe HTTP errors expose only the allowlisted status and stage', async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        code: 'private_backend_error',
        message: `Bearer ${SECRET}`,
        details: { responseBody: 'complete private response' },
      },
    }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  );

  await assert.rejects(
    readJsonObject(response, 'capture'),
    (error: unknown) => {
      assert.ok(error instanceof UserPdfOcrProbeError);
      assert.deepEqual(error.shape, {
        code: 'http',
        stage: 'capture',
        status: 502,
      });
      assert.equal(error.message, 'Capture Runtime rejected a probe request. stage=capture status=502');
      assert.doesNotMatch(error.message, new RegExp(SECRET, 'u'));
      assert.doesNotMatch(error.message, /complete private response/u);
      return true;
    },
  );
});

test('unexpected probe failures are replaced by a generic safe message', () => {
  const message = sanitizeProbeError(
    new Error(`SSE event contained Authorization: Bearer ${SECRET}`),
  );

  assert.equal(message, 'User PDF OCR probe failed.');
  assert.doesNotMatch(message, new RegExp(SECRET, 'u'));
});

test('probe reconnects after a closed stream and sends the last event cursor', async () => {
  const eventRequests: RequestInit[] = [];
  let eventRequestCount = 0;
  const fetchImplementation = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.endsWith('/events')) {
      eventRequests.push(init ?? {});
      eventRequestCount += 1;
      return eventRequestCount === 1
        ? (() => {
          const frame = eventFrame(1, 'checkpoint', 'extracting', { multiline: true });
          const split = frame.indexOf('\r\n') + 1;
          return chunkedSseResponse([frame.slice(0, split), frame.slice(split)]);
        })()
        : sseResponse(eventFrame(2, 'checkpoint', 'awaiting_structuring'));
    }
    if (url.endsWith(`/v2/captures/${CAPTURE_ID}`)) {
      return snapshotResponse('extracting', 1);
    }
    throw new Error(`Unexpected probe URL: ${url}`);
  };

  const result = await waitForExtraction(
    'http://runtime.test',
    CAPTURE_ID,
    SECRET,
    5_000,
    fetchImplementation,
  );

  assert.equal(result['stage'], 'awaiting_structuring');
  assert.equal(eventRequests.length, 2);
  assert.equal(new Headers(eventRequests[0]?.headers).get('Last-Event-ID'), null);
  assert.equal(new Headers(eventRequests[1]?.headers).get('Last-Event-ID'), '1');
});

test('probe rejects an unterminated final SSE frame at normal EOF', async () => {
  const fetchImplementation = async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    if (url.endsWith('/events')) {
      return sseResponse(eventFrame(1, 'checkpoint', 'extracting').replace(/\r\n\r\n$/u, ''));
    }
    throw new Error(`Unexpected probe URL: ${url}`);
  };

  await assert.rejects(
    waitForExtraction(
      'http://runtime.test',
      CAPTURE_ID,
      SECRET,
      5_000,
      fetchImplementation,
    ),
    (error) => error instanceof UserPdfOcrProbeError && error.shape.code === 'invalid_response',
  );
});

test('probe reconciles resync overflow before reconnecting', async () => {
  const eventRequests: RequestInit[] = [];
  let eventRequestCount = 0;
  let snapshotRequestCount = 0;
  const fetchImplementation = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.endsWith('/events')) {
      eventRequests.push(init ?? {});
      eventRequestCount += 1;
      return eventRequestCount === 1
        ? sseResponse(eventFrame(2, 'resync_required', 'resync', {
          eventId: `${CAPTURE_ID}/2`,
        }))
        : sseResponse(eventFrame(3, 'checkpoint', 'awaiting_structuring'));
    }
    if (url.endsWith(`/v2/captures/${CAPTURE_ID}`)) {
      snapshotRequestCount += 1;
      return snapshotResponse('extracting', 2);
    }
    throw new Error(`Unexpected probe URL: ${url}`);
  };

  const result = await waitForExtraction(
    'http://runtime.test',
    CAPTURE_ID,
    SECRET,
    5_000,
    fetchImplementation,
  );

  assert.equal(result['stage'], 'awaiting_structuring');
  assert.equal(snapshotRequestCount, 1);
  assert.equal(new Headers(eventRequests[1]?.headers).get('Last-Event-ID'), '2');
});

test('probe treats normal terminal stream closure as success, not timeout', async () => {
  let requestCount = 0;
  const fetchImplementation = async (input: Parameters<typeof globalThis.fetch>[0]) => {
    requestCount += 1;
    assert.match(String(input), /\/events$/u);
    return sseResponse(eventFrame(4, 'completed', 'completed'));
  };

  const result = await waitForExtraction(
    'http://runtime.test',
    CAPTURE_ID,
    SECRET,
    5_000,
    fetchImplementation,
  );

  assert.equal(result['eventType'], 'completed');
  assert.equal(requestCount, 1);
});

test('probe rejects a capture-boundary SSE mismatch without exposing payload data', async () => {
  const fetchImplementation = async () => sseResponse(
    eventFrame(1, 'checkpoint', 'extracting').replace(
      `"captureId":"${CAPTURE_ID}"`,
      '"captureId":"other-capture"',
    ),
  );

  await assert.rejects(
    waitForExtraction('http://runtime.test', CAPTURE_ID, SECRET, 5_000, fetchImplementation),
    (error: unknown) => {
      assert.ok(error instanceof UserPdfOcrProbeError);
      assert.deepEqual(error.shape, { code: 'invalid_response', stage: 'extraction' });
      assert.doesNotMatch(error.message, new RegExp(SECRET, 'u'));
      return true;
    },
  );
});

test('probe rejects an event id with the right capture prefix but wrong sequence suffix', async () => {
  const fetchImplementation = async () => sseResponse(
    eventFrame(1, 'checkpoint', 'extracting', {
      eventId: `${CAPTURE_ID}/1/extra`,
    }),
  );

  await assert.rejects(
    waitForExtraction('http://runtime.test', CAPTURE_ID, SECRET, 5_000, fetchImplementation),
    (error: unknown) => {
      assert.ok(error instanceof UserPdfOcrProbeError);
      assert.deepEqual(error.shape, { code: 'invalid_response', stage: 'extraction' });
      return true;
    },
  );
});
