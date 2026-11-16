import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildFinalizeIngestionRequest,
  buildOpenIngestionRequest,
  buildStartCaptureRequest,
  isTerminalCaptureStatus,
  startV2Capture,
  validateWorkerMirrorUrl,
} from './v2-capture-flow.ts';

const validSourceSha256 = 'b'.repeat(64);

test('validateWorkerMirrorUrl supports default and custom env var names', () => {
  assert.equal(validateWorkerMirrorUrl(undefined), undefined);
  assert.equal(
    validateWorkerMirrorUrl('http://127.0.0.1:43123', 'CAPTURE_REAL_MEDIA_WORKER_MIRROR_URL'),
    'http://127.0.0.1:43123',
  );
  assert.throws(
    () => validateWorkerMirrorUrl('http://localhost:43123', 'CAPTURE_REAL_MEDIA_WORKER_MIRROR_URL'),
    /CAPTURE_REAL_MEDIA_WORKER_MIRROR_URL/u,
  );
});

test('isTerminalCaptureStatus distinguishes every v2 terminal and non-terminal state', () => {
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    assert.equal(isTerminalCaptureStatus(terminal), true, `expected ${terminal} to be terminal`);
  }
  for (const nonTerminal of [
    'created',
    'waiting_input',
    'extracting',
    'awaiting_structuring',
    'structuring',
  ]) {
    assert.equal(isTerminalCaptureStatus(nonTerminal), false, `expected ${nonTerminal} to be non-terminal`);
  }
});

test('v2 request builders support pdf, image, and audio with runtime or host structuring', () => {
  assert.deepEqual(
    buildOpenIngestionRequest({
      clientRequestId: 'req-1',
      kind: 'audio',
      fileName: 'sample.mp3',
      mediaType: 'audio/mpeg',
      totalBytes: 4096,
      sourceSha256: validSourceSha256,
    }),
    {
      protocolVersion: '2',
      kind: 'audio',
      mode: 'file',
      clientRequestId: 'req-1',
      fileName: 'sample.mp3',
      mediaType: 'audio/mpeg',
      totalBytes: 4096,
      sourceSha256: validSourceSha256,
    },
  );

  assert.deepEqual(
    buildFinalizeIngestionRequest({
      totalBytes: 4096,
      sha256: validSourceSha256,
    }),
    {
      protocolVersion: '2',
      totalBytes: 4096,
      sha256: validSourceSha256,
    },
  );

  assert.deepEqual(
    buildStartCaptureRequest({
      clientRequestId: 'req-2',
      ingestionId: 'ing-1',
      structuringMode: 'host',
    }),
    {
      protocolVersion: '2',
      clientRequestId: 'req-2',
      ingestionId: 'ing-1',
      structuringMode: 'host',
      targetLanguage: 'zh-TW',
      startPolicy: 'eager',
    },
  );
});

test('startV2Capture executes open, chunked PUTs, finalize, and capture start in order', async () => {
  const sourceBytes = Buffer.from('hello-world-chunked-payload', 'utf8');
  const expectedSha = createHash('sha256').update(sourceBytes).digest('hex');
  const calls: Array<{
    readonly path: string;
    readonly method: string | undefined;
    readonly headers: Record<string, string>;
    readonly body: RequestInit['body'];
  }> = [];

  const operation = await startV2Capture({
    request: async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const headers = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      calls.push({ path, method: init.method, headers, body: init.body });
      if (path === '/v2/ingestions') {
        return { ingestionId: 'ing-42', status: 'open' } as T;
      }
      if (path === '/v2/ingestions/ing-42/finalize') {
        return { ingestionId: 'ing-42', status: 'ready' } as T;
      }
      if (path === '/v2/captures') {
        return { captureId: 'cap-99', status: 'created' } as T;
      }
      return undefined as T;
    },
    fileName: 'scan.png',
    kind: 'image',
    mediaType: 'image/png',
    sourceBytes,
    structuringMode: 'host',
    chunkBytes: 10,
  });

  assert.deepEqual(operation, { captureId: 'cap-99', status: 'created' });
  assert.deepEqual(
    calls.map((call) => `${call.method ?? 'GET'} ${call.path}`),
    [
      'POST /v2/ingestions',
      'PUT /v2/ingestions/ing-42/chunks/0',
      'PUT /v2/ingestions/ing-42/chunks/1',
      'PUT /v2/ingestions/ing-42/chunks/2',
      'POST /v2/ingestions/ing-42/finalize',
      'POST /v2/captures',
    ],
  );

  const openBody = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
  assert.equal(openBody['kind'], 'image');
  assert.equal(openBody['mediaType'], 'image/png');
  assert.equal(openBody['totalBytes'], sourceBytes.length);
  assert.equal(openBody['sourceSha256'], expectedSha);
  assert.equal(openBody['clientRequestId'], calls[0]?.headers['x-idempotency-key']);

  assert.equal(calls[1]?.headers['content-range'], `bytes 0-9/${sourceBytes.length}`);
  assert.equal(calls[2]?.headers['content-range'], `bytes 10-19/${sourceBytes.length}`);
  assert.equal(calls[3]?.headers['content-range'], `bytes 20-${sourceBytes.length - 1}/${sourceBytes.length}`);
  assert.equal(
    calls[1]?.headers['digest'],
    `sha-256=${createHash('sha256').update(sourceBytes.subarray(0, 10)).digest('hex')}`,
  );
  assert.ok(calls[1]?.headers['x-idempotency-key']);

  const finalizeBody = JSON.parse(String(calls[4]?.body)) as Record<string, unknown>;
  assert.deepEqual(finalizeBody, {
    protocolVersion: '2',
    totalBytes: sourceBytes.length,
    sha256: expectedSha,
  });

  const startBody = JSON.parse(String(calls[5]?.body)) as Record<string, unknown>;
  assert.equal(startBody['ingestionId'], 'ing-42');
  assert.equal(startBody['structuringMode'], 'host');
  assert.equal(startBody['startPolicy'], 'eager');
  assert.equal(startBody['clientRequestId'], calls[5]?.headers['x-idempotency-key']);
});
