import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { firstValueFrom } from 'rxjs';

import { DETERMINISTIC_FIXTURES, DETERMINISTIC_MAX_UPLOAD_BYTES } from './constants/deterministic.ts';
import { createIngestion, validateReady, verifyHostStructuring, verifyRuntimeCapture } from './deterministic-http.ts';

function readyResponse() {
  return { status: 200, body: {
    ready: true, service: 'capture-runtime', apiVersion: '2.0', runtimeVersion: '0.9.0',
    captureDocumentSchemaVersion: '2', contractSetVersion: '2', message: null,
    capabilities: {
      captureKinds: ['pdf', 'image', 'audio'], structuringModes: ['runtime', 'host'],
      supportsCancellation: true, supportsRawDiagnostics: true, maxUploadBytes: DETERMINISTIC_MAX_UPLOAD_BYTES,
    },
    ocrCompute: {
      apiVersion: '2.0', schemaVersion: '1', service: 'capture-runtime', runtimeVersion: '0.9.0',
      contractSetVersion: '2', contractSha256: 'a'.repeat(64), workerSha256: 'b'.repeat(64),
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

test('capture helpers consume operation/raw/result envelopes for every fixture and host mode', async (t) => {
  for (const fixture of DETERMINISTIC_FIXTURES) {
    for (const mode of ['runtime', 'host']) {
      let operation;
      let capturePayload;
      const context = await serve(t, (request, bytes) => {
        if (request.url === '/v2/ingestions') {
          const body = JSON.parse(bytes.toString('utf8'));
          return { status: 201, body: { protocolVersion: '2', ingestionId: 'upload', kind: body.kind, status: 'open' } };
        }
        if (request.method === 'PUT') return { status: 200, body: { ingestionId: 'upload', nextOffset: bytes.length, nextChunkIndex: 1 } };
        if (request.url.endsWith('/finalize')) return { status: 200, body: { ingestionId: 'upload', status: 'ready', finalizedSha256: digest(fixture.content) } };
        const { raw, result } = captureResult(fixture);
        if (request.method === 'POST' && request.url === '/v2/captures') {
          assert.equal(request.headers['content-type'], 'application/json');
          const body = JSON.parse(bytes.toString('utf8'));
          assert.equal(body.protocolVersion, '2');
          assert.equal(body.ingestionId, 'upload');
          assert.equal(body.structuringMode, mode);
          assert.equal(body.startPolicy, 'eager');
          assert.equal(body.clientRequestId, request.headers['x-idempotency-key']);
          if (capturePayload && JSON.stringify(body) !== capturePayload) {
            return { status: 409, body: { error: { code: 'idempotency_conflict', message: 'Metadata conflicts.' } } };
          }
          capturePayload = JSON.stringify(body);
          operation = {
            protocolVersion: '2', captureId: 'capture', ingestionId: 'upload',
            kind: fixture.mediaType === 'application/pdf' ? 'pdf' : fixture.locatorKind === 'time' ? 'audio' : 'image',
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
      const evidence = await firstValueFrom(mode === 'host'
        ? verifyHostStructuring(context, fixture) : verifyRuntimeCapture(context, fixture));
      assert.equal(evidence.structuringMode, mode);
      assert.equal(evidence.segments, fixture.expectedSegments);
      assert.equal(evidence.textProjection, true);
    }
  }
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
