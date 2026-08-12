import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeSseEvents } from './progressive-audio-oracle.ts';

function event(sequence: number, eventType: string, stage: string, progress: number) {
  return JSON.stringify({
    protocolVersion: '2',
    eventId: `capture-1/${sequence}`,
    sequence,
    captureId: 'capture-1',
    kind: 'audio',
    eventType,
    stage,
    progress,
    coveredUntilMs: 300_000,
    partialRevision: 1,
    createdAt: '2026-01-01T00:00:00Z',
  });
}

test('progressive audio oracle consumes an active SSE checkpoint before stream completion', async () => {
  const payload = event(1, 'checkpoint', 'extracting', 0.25);
  const split = payload.indexOf(',"coveredUntilMs"') + 1;
  let pullCount = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) {
        controller.enqueue(new TextEncoder().encode(
          `id: 1\r\nevent: checkpoint\r\ndata: ${payload.slice(0, split)}\r\n`,
        ));
        return;
      }
      controller.enqueue(new TextEncoder().encode(
        `data:${payload.slice(split)}\r\n\r\n`,
      ));
    },
    cancel() {
      cancelled = true;
    },
  });
  const seen: number[] = [];

  await consumeSseEvents(
    new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    'capture-1',
    (value) => {
      seen.push(value.sequence);
      return true;
    },
  );

  assert.deepEqual(seen, [1]);
  assert.equal(cancelled, true);
});

test('progressive audio oracle rejects SSE metadata that disagrees with the payload', async () => {
  const response = new Response(
    `id: 2\nevent: checkpoint\ndata: ${event(1, 'checkpoint', 'extracting', 0.25)}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

  await assert.rejects(
    consumeSseEvents(response, 'capture-1', () => undefined),
    /event id did not match its sequence/u,
  );
});

test('progressive audio oracle rejects an event id with an extra sequence suffix', async () => {
  const response = new Response(
    `id: 1\nevent: checkpoint\ndata: ${event(1, 'checkpoint', 'extracting', 0.25).replace(
      'capture-1/1',
      'capture-1/1/extra',
    )}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

  await assert.rejects(
    consumeSseEvents(response, 'capture-1', () => undefined),
    /event cursor was invalid/u,
  );
});

test('progressive audio oracle rejects an unterminated final EOF frame', async () => {
  const response = new Response(
    `id: 1\nevent: checkpoint\ndata: ${event(1, 'checkpoint', 'extracting', 0.25)}`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

  await assert.rejects(
    consumeSseEvents(response, 'capture-1', () => undefined),
    /incomplete event frame/u,
  );
});
