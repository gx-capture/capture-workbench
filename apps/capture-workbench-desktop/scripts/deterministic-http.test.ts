import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSseFrames } from './deterministic-http.ts';

test('deterministic SSE parser preserves ordered replay frames and multiline data', () => {
  const frames = parseSseFrames(
    ': fixture stream\r\n' +
      'id: 2\r\n' +
      'event: checkpoint\r\n' +
      'data: {"sequence":\r\n' +
      'data: 2}\r\n\r\n' +
      'id: 3\n' +
      'event: completed\n' +
      'data: {"sequence":3}\n\n',
  );

  assert.deepEqual(frames, [
    {
      id: '2',
      event: 'checkpoint',
      data: '{"sequence":\n2}',
    },
    {
      id: '3',
      event: 'completed',
      data: '{"sequence":3}',
    },
  ]);
});
