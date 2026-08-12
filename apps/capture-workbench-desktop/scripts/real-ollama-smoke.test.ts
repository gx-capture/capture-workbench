import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertLiveReconnectWindow,
  assertStreamingEventOrder,
  parseStreamingEventChunks,
  parseStreamingEvents,
} from './real-ollama-smoke.ts';

test('real Ollama SSE parser validates capture identity and split CRLF framing', () => {
  const events = parseStreamingEventChunks([
    'id: 1\r',
    '\nevent: accepted\r\ndata: {"captureId":"capture-1","eventId":"capture-1/1",\r\n',
    'data: "sequence":1,"eventType":"accepted","stage":"extracting","progress":0}\r\n\r',
    '\nid: 2\nevent: checkpoint\ndata: {"captureId":"capture-1","eventId":"capture-1/2","sequence":2,"eventType":"checkpoint","stage":"extracting","progress":0.5}\n\n',
    'id: 3\nevent: completed\ndata: {"captureId":"capture-1","eventId":"capture-1/3","sequence":3,"eventType":"completed","stage":"completed","progress":1}\n\n',
  ], 'capture-1');

  assert.deepEqual(events, [
    {
      captureId: 'capture-1',
      eventId: 'capture-1/1',
      sequence: 1,
      eventType: 'accepted',
      stage: 'extracting',
      progress: 0,
    },
    {
      captureId: 'capture-1',
      eventId: 'capture-1/2',
      sequence: 2,
      eventType: 'checkpoint',
      stage: 'extracting',
      progress: 0.5,
    },
    {
      captureId: 'capture-1',
      eventId: 'capture-1/3',
      sequence: 3,
      eventType: 'completed',
      stage: 'completed',
      progress: 1,
    },
  ]);
  assert.doesNotThrow(() => assertStreamingEventOrder(events, 0, true, 'capture-1'));
});

test('real Ollama SSE parser rejects mismatched canonical event identities', () => {
  assert.throws(
    () => parseStreamingEvents(
      'id: 1\nevent: accepted\ndata: {"captureId":"capture-1","eventId":"capture-1/1-extra","sequence":1,"eventType":"accepted","stage":"extracting"}\n\n',
      'capture-1',
    ),
    /metadata did not match/u,
  );
  assert.throws(
    () => parseStreamingEvents(
      'id: 1\nevent: accepted\ndata: {"captureId":"capture-2","eventId":"capture-2/1","sequence":1,"eventType":"accepted","stage":"extracting"}\n\n',
      'capture-1',
    ),
    /metadata did not match/u,
  );
});

test('real Ollama SSE parser rejects an unterminated final frame', () => {
  assert.throws(
    () => parseStreamingEventChunks([
      'id: 1\nevent: accepted\ndata: {"captureId":"capture-1","eventId":"capture-1/1","sequence":1,"eventType":"accepted","stage":"extracting"}',
    ], 'capture-1'),
    /incomplete event frame/u,
  );
});

test('real Ollama smoke fails the live reconnect gate if disconnect observes a terminal race', () => {
  assert.doesNotThrow(() => assertLiveReconnectWindow({ status: 'extracting' }));
  assert.throws(
    () => assertLiveReconnectWindow({ status: 'completed' }),
    /terminal race.*live-reconnect gate failed/u,
  );
});

test('real Ollama smoke gates capture progress on incremental SSE rather than polling', async () => {
  const source = await readFile(new URL('./real-ollama-smoke.ts', import.meta.url), 'utf8');
  assert.match(source, /readStreamingEventsIncrementally\(/u);
  assert.doesNotMatch(source, /waitForTerminal\(/u);
  assert.match(source, /Last-Event-ID/u);
});
