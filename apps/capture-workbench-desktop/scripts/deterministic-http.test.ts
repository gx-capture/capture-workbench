import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { firstValueFrom } from 'rxjs';

import { DETERMINISTIC_FIXTURES, DETERMINISTIC_MAX_UPLOAD_BYTES } from './constants/deterministic.ts';
import { createIngestion, validateReady, verifyHostStructuring, verifyRuntimeCapture } from './deterministic-http.ts';

// validateReady only requires the two versions to agree, so any value works.
const SYNTHETIC_RUNTIME_VERSION = '0.0.0-test';

function readyResponse() {
  return { status: 200, body: {
    ready: true, service: 'capture-runtime', apiVersion: '2.0', runtimeVersion: SYNTHETIC_RUNTIME_VERSION,
    captureDocumentSchemaVersion: '2', contractSetVersion: '2', message: null,
    capabilities: {
      captureKinds: ['pdf', 'image', 'recording'], structuringModes: ['runtime', 'host'],
      supportsCancellation: true, supportsRawDiagnostics: true, maxUploadBytes: DETERMINISTIC_MAX_UPLOAD_BYTES,
      maxChunkBytes: 4 * 1024 * 1024, checkpointIntervalMs: 300_000,
      heartbeatIntervalMs: 5_000, stallTimeoutMs: 90_000, supportsProgressiveRecording: true,
    },
    ocrCompute: {
      apiVersion: '2.0', schemaVersion: '1', service: 'capture-runtime', runtimeVersion: SYNTHETIC_RUNTIME_VERSION,
      contractSetVersion: '2', contractSetSha256: 'a'.repeat(64), workerSha256: 'b'.repeat(64),
      mode: 'cpu-fallback', adapterClass: 'unknown', reasonCode: 'no_compatible_gpu',
      userNoticeRequired: true, noticeCode: 'ocr_cpu_fallback',
    },
  } };
}

test('readiness strictly accepts the migrated readiness and nested OCR shapes', () => {
  assert.doesNotThrow(() => validateReady(readyResponse()));
  for (const field of Object.keys(readyResponse().body)) {
    const response = readyResponse();
    delete response.body[field];
    assert.throws(() => validateReady(response), field);
  }
  const extra = readyResponse();
  Object.assign(extra.body, { unexpected: true });
  assert.throws(() => validateReady(extra));
  const nested = readyResponse();
  Object.assign(nested.body.ocrCompute, { unexpected: true });
  assert.throws(() => validateReady(nested));
  const wrongVersion = readyResponse();
  wrongVersion.body.contractSetVersion = '1';
  assert.throws(() => validateReady(wrongVersion));
});

async function serve(t, handler) {
  const failures: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = handler(request, Buffer.concat(chunks));
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end('{}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.deepEqual(failures, []);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { runtimePort: address.port, host: `127.0.0.1:${address.port}`, token: 'fixture-only' };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('ingestion uses ordered one-MiB chunks, matching request ids, digests and finalization', async (t) => {
  const fixture = { ...DETERMINISTIC_FIXTURES[0], content: Buffer.alloc(1_048_576 + 37, 0x61) };
  let requestId: string;
  const received: Buffer[] = [];
  const calls: string[] = [];
  const context = await serve(t, (request, bytes) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === '/v2/ingestions') {
      assert.equal(request.headers['content-type'], 'application/json');
      const body = JSON.parse(bytes.toString('utf8'));
      requestId = body.clientRequestId;
      assert.equal(request.headers['x-idempotency-key'], requestId);
      assert.deepEqual(body, {
        protocolVersion: '2', clientRequestId: requestId, kind: 'pdf', mode: 'file',
        fileName: fixture.fileName, mediaType: fixture.mediaType, totalBytes: fixture.content.length,
      });
      return { status: 201, body: { protocolVersion: '2', ingestionId: 'upload', kind: 'pdf', status: 'open' } };
    }
    if (request.method === 'PUT') {
      const index = received.length;
      const offset = index * 1_048_576;
      assert.equal(request.url, `/v2/ingestions/upload/chunks/${index}`);
      assert.equal(request.headers['content-type'], 'application/octet-stream');
      assert.equal(request.headers['x-idempotency-key'], `${requestId}-chunk-${index}`);
      assert.equal(request.headers['content-range'], `bytes ${offset}-${offset + bytes.length - 1}/${fixture.content.length}`);
      assert.equal(request.headers['digest'], `sha-256=${digest(bytes)}`);
      received.push(bytes);
      return { status: 200, body: { ingestionId: 'upload', nextOffset: offset + bytes.length, nextChunkIndex: index + 1 } };
    }
    assert.equal(request.url, '/v2/ingestions/upload/finalize');
    assert.equal(request.method, 'POST');
    assert.deepEqual(Buffer.concat(received), fixture.content);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), {
      protocolVersion: '2', totalBytes: fixture.content.length, sha256: digest(fixture.content),
    });
    return { status: 200, body: { ingestionId: 'upload', status: 'ready', finalizedSha256: digest(fixture.content) } };
  });
  assert.equal(await firstValueFrom(createIngestion(context, fixture)), 'upload');
  assert.deepEqual(calls, [
    'POST /v2/ingestions', 'PUT /v2/ingestions/upload/chunks/0',
    'PUT /v2/ingestions/upload/chunks/1', 'POST /v2/ingestions/upload/finalize',
  ]);
});

/** Answers the ingestion requests of `createIngestion`, or returns undefined for any other request. */
function ingestionAnswer(fixture, request, bytes) {
  if (request.url === '/v2/ingestions') {
    const body = JSON.parse(bytes.toString('utf8'));
    return { status: 201, body: { protocolVersion: '2', ingestionId: 'upload', kind: body.kind, status: 'open' } };
  }
  if (request.method === 'PUT') return { status: 200, body: { ingestionId: 'upload', nextOffset: bytes.length, nextChunkIndex: 1 } };
  if (request.url.endsWith('/finalize')) return { status: 200, body: { ingestionId: 'upload', status: 'ready', finalizedSha256: digest(fixture.content) } };
  return undefined;
}

function fixtureKind(fixture) {
  return fixture.mediaType === 'application/pdf' ? 'pdf' : fixture.locatorKind === 'time' ? 'recording' : 'image';
}

function assertCaptureStart(request, bytes, structuringMode) {
  assert.equal(request.headers['content-type'], 'application/json');
  const body = JSON.parse(bytes.toString('utf8'));
  assert.equal(body.protocolVersion, '2');
  assert.equal(body.ingestionId, 'upload');
  assert.equal(body.structuringMode, structuringMode);
  assert.equal(body.startPolicy, 'eager');
  assert.equal(body.clientRequestId, request.headers['x-idempotency-key']);
  return body;
}

test('a runtime-structured capture is read through its operation/raw/result envelope for every fixture', async (t) => {
  for (const fixture of DETERMINISTIC_FIXTURES) {
    let operation;
    let capturePayload;
    const context = await serve(t, (request, bytes) => {
      const ingestion = ingestionAnswer(fixture, request, bytes);
      if (ingestion) return ingestion;
      const { raw, result } = captureResult(fixture);
      if (request.method === 'POST' && request.url === '/v2/captures') {
        const body = assertCaptureStart(request, bytes, 'runtime');
        if (capturePayload && JSON.stringify(body) !== capturePayload) {
          return { status: 409, body: { error: { code: 'idempotency_conflict', message: 'Metadata conflicts.' } } };
        }
        capturePayload = JSON.stringify(body);
        operation = {
          protocolVersion: '2', captureId: 'capture', ingestionId: 'upload', kind: fixtureKind(fixture),
          status: 'completed', progress: 1, partialRevision: 0, lastEventSequence: 1,
          source: raw.source, error: null, createdAt: raw.createdAt,
          updatedAt: result.completedAt, completedAt: result.completedAt,
        };
        return { status: 202, body: operation };
      }
      assert.equal(request.method, 'GET');
      if (request.url === '/v2/captures/capture') return { status: 200, body: operation };
      assert.equal(request.url, '/v2/captures/capture/result');
      return { status: 200, body: { operation, raw, result } };
    });
    const evidence = await firstValueFrom(verifyRuntimeCapture(context, fixture));
    assert.equal(evidence.structuringMode, 'runtime');
    assert.equal(evidence.segments, fixture.expectedSegments);
    assert.equal(evidence.textProjection, true);
  }
});

/**
 * A runtime that serves a host-structured capture as the product runtime does:
 * it waits at the checkpoint (or reports `status`), answers a repeated create
 * with the same capture and a different request under the same key with 409
 * `idempotency_conflict`, serves raw and OCR, has no result, and is gone after
 * the delete. `idempotency` replaces those answers with a faulty runtime's.
 */
async function serveHostStructuredCapture(
  t, fixture, calls: string[], status = 'awaiting_structuring',
  idempotency: 'kept' | 'new-capture-on-replay' | 'conflict-accepted' = 'kept',
) {
  let deleted = false;
  let createPayload: string | undefined;
  let creates = 0;
  return serve(t, (request, bytes) => {
    const ingestion = ingestionAnswer(fixture, request, bytes);
    if (ingestion) return ingestion;
    calls.push(`${request.method} ${request.url}`);
    const { raw } = captureResult(fixture);
    const operation = {
      protocolVersion: '2', captureId: 'capture', ingestionId: 'upload', kind: fixtureKind(fixture),
      status, progress: status === 'completed' ? 1 : 0.9, partialRevision: 0, lastEventSequence: 1,
      source: raw.source, error: null, createdAt: raw.createdAt, updatedAt: raw.createdAt,
      completedAt: status === 'completed' ? raw.createdAt : null,
    };
    if (request.method === 'POST' && request.url === '/v2/captures') {
      const body = JSON.stringify(assertCaptureStart(request, bytes, 'host'));
      creates += 1;
      if (createPayload !== undefined && body !== createPayload && idempotency !== 'conflict-accepted') {
        return { status: 409, body: { error: { code: 'idempotency_conflict', message: 'Metadata conflicts.' } } };
      }
      createPayload ??= body;
      const replayedAsNew = idempotency === 'new-capture-on-replay' && creates > 1;
      return { status: 202, body: replayedAsNew ? { ...operation, captureId: `capture-${creates}` } : operation };
    }
    if (request.method === 'DELETE') {
      deleted = true;
      return { status: 204, body: '' };
    }
    if (deleted) return { status: 404, body: { error: { code: 'capture_not_found', message: 'Gone.' } } };
    if (request.url === '/v2/captures/capture') return { status: 200, body: operation };
    if (request.url === '/v2/captures/capture/raw') return { status: 200, body: raw };
    if (request.url === '/v2/captures/capture/ocr') {
      return { status: 200, body: { captureId: 'capture', status: 'completed', pages: raw.segments.map(() => ({})) } };
    }
    assert.equal(request.url, '/v2/captures/capture/result');
    return { status: 409, body: { error: { code: 'result_unavailable', message: 'No result yet.' } } };
  });
}

test('a host-structured document capture is read at its checkpoint and deleted, with no result', async (t) => {
  for (const fixture of DETERMINISTIC_FIXTURES.filter((candidate) => candidate.locatorKind === 'page')) {
    const calls: string[] = [];
    const context = await serveHostStructuredCapture(t, fixture, calls);
    const evidence = await firstValueFrom(verifyHostStructuring(context, fixture));
    assert.deepEqual(evidence, {
      fileName: fixture.fileName, captureId: 'capture', structuringMode: 'host',
      status: 'awaiting_structuring', segments: fixture.expectedSegments,
      idempotency: true, ocrCompleted: true, resultUnavailable: true, deleted: true,
    });
    // The create, its replay and a different request under the same key.
    assert.deepEqual(calls, [
      'POST /v2/captures', 'POST /v2/captures', 'POST /v2/captures',
      'GET /v2/captures/capture', 'GET /v2/captures/capture/raw',
      'GET /v2/captures/capture/ocr', 'GET /v2/captures/capture/result',
      'DELETE /v2/captures/capture', 'GET /v2/captures/capture',
    ]);
  }
});

test('a host-structured capture whose create is not idempotent is rejected', async (t) => {
  const fixture = DETERMINISTIC_FIXTURES[1];
  const replayed = await serveHostStructuredCapture(t, fixture, [], 'awaiting_structuring', 'new-capture-on-replay');
  await assert.rejects(firstValueFrom(verifyHostStructuring(replayed, fixture)), {
    code: 'ERR_ASSERTION', actual: 'capture-2', expected: 'capture',
  });
  const accepted = await serveHostStructuredCapture(t, fixture, [], 'awaiting_structuring', 'conflict-accepted');
  await assert.rejects(firstValueFrom(verifyHostStructuring(accepted, fixture)), {
    code: 'ERR_ASSERTION', actual: 202, expected: 409,
  });
});

test('a host-structured capture reported completed is not the product runtime’s checkpoint', async (t) => {
  const fixture = DETERMINISTIC_FIXTURES[1];
  const context = await serveHostStructuredCapture(t, fixture, [], 'completed');
  await assert.rejects(firstValueFrom(verifyHostStructuring(context, fixture)), {
    code: 'ERR_ASSERTION', actual: 'completed', expected: 'awaiting_structuring',
  });
});

function captureResult(fixture) {
  const source = { fileName: fixture.fileName, mediaType: fixture.mediaType, bytes: fixture.content.length, sha256: digest(fixture.content) };
  const segments = Array.from({ length: fixture.expectedSegments }, (_, order) => ({
    segmentId: `segment-${order}`, order, text: `text-${order}`,
    locator: fixture.locatorKind === 'time' ? { kind: 'time', startMs: order * 1000, endMs: (order + 1) * 1000 } : { kind: 'page', page: order + 1 },
  }));
  const engine = { engine: 'fake', model: 'fixture', digest: `sha256:${'a'.repeat(64)}`, device: 'fake' };
  const raw = {
    schemaVersion: '2', diagnosticOnly: true, source, segments,
    sourceText: segments.map((segment) => segment.text).join('\n'),
    extractionEngine: engine, warnings: [], createdAt: '2000-01-01T00:00:00Z',
  };
  const blocks = segments.map((segment) => ({
    blockId: `block-${segment.order}`, order: segment.order, type: 'paragraph',
    sourceSegmentId: segment.segmentId, locator: segment.locator,
    sourceText: segment.text, targetText: `[zh-TW] ${segment.text}`,
  }));
  const result = {
    schemaVersion: '2', source, rawSegments: segments, blocks, sourceText: raw.sourceText,
    targetText: blocks.map((block) => block.targetText).join('\n'), extractionEngine: engine,
    structuringEngine: engine, warnings: [], createdAt: raw.createdAt, completedAt: '2000-01-01T00:00:01Z',
  };
  return { raw, result };
}
