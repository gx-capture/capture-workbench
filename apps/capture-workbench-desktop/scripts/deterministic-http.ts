import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import {
  Observable,
  from,
  toArray,
  catchError,
  concatMap,
  defaultIfEmpty,
  filter,
  exhaustMap,
  map,
  of,
  take,
  takeWhile,
  tap,
  throwError,
  timer,
} from 'rxjs';

import {
  DETERMINISTIC_MAX_UPLOAD_BYTES,
  DETERMINISTIC_SCHEMA_VERSION,
} from './constants/deterministic.ts';

const maxUploadBytes = DETERMINISTIC_MAX_UPLOAD_BYTES;
const schemaVersion = DETERMINISTIC_SCHEMA_VERSION;

export function verifyRequestPolicy(context) {
  return requestJson({ ...context, token: undefined }).pipe(
    tap((unauthorized) => {
      assertApiError(unauthorized, 401, 'unauthorized');
      assert.equal(unauthorized.headers['www-authenticate'], 'Bearer');
    }),
    concatMap((unauthorized) =>
      requestJson({ ...context, origin: 'https://untrusted.invalid' }).pipe(
        tap((rejectedOrigin) => {
          assertApiError(rejectedOrigin, 403, 'origin_not_allowed');
          assert.equal(rejectedOrigin.headers['access-control-allow-origin'], undefined);
        }),
        concatMap((rejectedOrigin) =>
          requestJson({ ...context, host: `localhost:${context.runtimePort}` }).pipe(
            tap((rejectedHostName) => assertApiError(rejectedHostName, 400, 'invalid_host')),
            concatMap((rejectedHostName) =>
              requestJson({
                ...context,
                host: `127.0.0.1:${differentPort(context.runtimePort)}`,
              }).pipe(
                tap((rejectedHostPort) => assertApiError(rejectedHostPort, 400, 'invalid_host')),
                concatMap((rejectedHostPort) =>
                  requestJson({
                    ...context,
                    token: undefined,
                    method: 'OPTIONS',
                    headers: {
                      'access-control-request-method': 'POST',
                      'access-control-request-headers':
                        'authorization,content-type,x-idempotency-key',
                    },
                  }).pipe(
                    map((preflight) => {
                      assert.equal(preflight.status, 200);
                      assert.equal(preflight.headers['access-control-allow-origin'], context.origin);
                      assert.match(preflight.headers['access-control-allow-methods'], /DELETE/u);
                      assert.match(preflight.headers['access-control-allow-headers'], /X-Idempotency-Key/u);
                      return {
                        unauthorized: unauthorized.status,
                        originRejected: rejectedOrigin.status,
                        hostNameRejected: rejectedHostName.status,
                        wrongAuthorityPortRejected: rejectedHostPort.status,
                        preflight: preflight.status,
                      };
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export function verifyRequirements(context) {
  return requestJson({ ...context, path: '/v2/runtime/requirements' }).pipe(
    concatMap((requirements) => {
      assert.equal(requirements.status, 200);
      const requirementIds = requirements.body.items.map((item) => item.requirementId);
      assert.deepEqual(requirementIds, [
        'windowsml-ocr',
        'speech-recognition',
        'ollama-runtime',
        'capture-ollama-model',
      ]);
      const installationKey = randomUUID();
      const installationPayload = JSON.stringify({ requirementId: 'speech-recognition', consent: true });
      return requestJson({
        ...context,
        method: 'POST',
        path: '/v2/runtime/installations',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': installationKey },
        body: installationPayload,
      }).pipe(
        concatMap((installation) => {
          assert.equal(installation.status, 202);
          assert.equal(installation.body.requirementId, 'speech-recognition');
          assert.equal(typeof installation.body.installationId, 'string');
          assertJobTimestamps(installation.body);
          return requestJson({
            ...context,
            method: 'POST',
            path: '/v2/runtime/installations',
            headers: { 'content-type': 'application/json', 'x-idempotency-key': installationKey },
            body: installationPayload,
          }).pipe(
            map((repeated) => {
              assert.equal(repeated.body.installationId, installation.body.installationId);
              return { requirementIds, installationIdempotency: true };
            }),
          );
        }),
      );
    }),
  );
}

// Follow the desktop bridge: metadata, ordered chunks, finalize, JSON capture start.
export function createIngestion(context, fixture) {
  const clientRequestId = randomUUID();
  const kind = fixtureKind(fixture);
  const metadata = {
    protocolVersion: '2', clientRequestId, kind, mode: 'file',
    fileName: fixture.fileName, mediaType: fixture.mediaType,
    totalBytes: fixture.content.length,
  };
  return requestJson({
    ...context, method: 'POST', path: '/v2/ingestions',
    headers: { 'content-type': 'application/json', 'x-idempotency-key': clientRequestId },
    body: JSON.stringify(metadata),
  }).pipe(
    concatMap((opened) => {
      assert.equal(opened.status, 201);
      assert.equal(opened.body.protocolVersion, '2');
      assert.equal(opened.body.status, 'open');
      assert.equal(opened.body.kind, kind);
      assert.equal(typeof opened.body.ingestionId, 'string');
      const ingestionId = opened.body.ingestionId;
      const chunks = Array.from({ length: Math.ceil(fixture.content.length / 1_048_576) }, (_, index) => index);
      return from(chunks).pipe(
        concatMap((index) => {
          const offset = index * 1_048_576;
          const body = fixture.content.subarray(offset, offset + 1_048_576);
          return requestJson({
            ...context, method: 'PUT', path: `/v2/ingestions/${ingestionId}/chunks/${index}`,
            headers: {
              'content-type': 'application/octet-stream',
              'x-idempotency-key': `${clientRequestId}-chunk-${index}`,
              'content-range': `bytes ${offset}-${offset + body.length - 1}/${fixture.content.length}`,
              digest: `sha-256=${sha256(body)}`,
            }, body,
          }).pipe(tap((chunk) => {
            assert.equal(chunk.status, 200);
            assert.equal(chunk.body.ingestionId, ingestionId);
            assert.equal(chunk.body.nextOffset, offset + body.length);
            assert.equal(chunk.body.nextChunkIndex, index + 1);
          }));
        }),
        toArray(),
        concatMap(() => requestJson({
          ...context, method: 'POST', path: `/v2/ingestions/${ingestionId}/finalize`,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocolVersion: '2', totalBytes: fixture.content.length, sha256: sha256(fixture.content) }),
        })),
        map((finalized) => {
          assert.equal(finalized.status, 200);
          assert.equal(finalized.body.ingestionId, ingestionId);
          assert.equal(finalized.body.status, 'ready');
          assert.equal(finalized.body.finalizedSha256, sha256(fixture.content));
          return ingestionId;
        }),
      );
    }),
  );
}

export function verifyRuntimeCapture(context, fixture, structuringMode = 'runtime') {
  return createIngestion(context, fixture).pipe(
    concatMap((ingestionId) => {
      const clientRequestId = randomUUID();
      const payload = {
        protocolVersion: '2', clientRequestId, ingestionId,
        structuringMode, startPolicy: 'eager', targetLanguage: 'zh-TW',
      };
      const start = (body = payload) => requestJson({
        ...context, method: 'POST', path: '/v2/captures',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': clientRequestId },
        body: JSON.stringify(body),
      });
      return start().pipe(
        concatMap((created) => {
          validateJob(created, 202, ingestionId, fixtureKind(fixture));
          const captureId = created.body.captureId;
          return start().pipe(
            tap((repeated) => {
              validateJob(repeated, 202, ingestionId, fixtureKind(fixture));
              assert.equal(repeated.body.captureId, captureId);
            }),
            concatMap(() => start({ ...payload, targetLanguage: 'en' })),
            tap((conflict) => assertApiError(conflict, 409, 'idempotency_conflict')),
            concatMap(() => requestJson({ ...context, path: `/v2/captures/${captureId}` })),
            tap((status) => validateJob(status, 200, ingestionId, fixtureKind(fixture))),
            concatMap(() => requestJson({ ...context, path: `/v2/captures/${captureId}/result` })),
            map((response) => {
              assert.equal(response.status, 200);
              assert.deepEqual(Object.keys(response.body).sort(), ['operation', 'raw', 'result']);
              validateJob({ ...response, body: response.body.operation }, 200, ingestionId, fixtureKind(fixture));
              assert.equal(response.body.operation.captureId, captureId);
              validateRaw(fixture, { ...response, body: response.body.raw });
              const result = response.body.result;
              validateResult(fixture, response.body.raw, { ...response, body: result }, 'zh-TW');
              return {
                fileName: fixture.fileName, captureId, structuringMode,
                locatorKind: result.blocks[0].locator.kind,
                segments: result.rawSegments.length,
                jsonReparsed: JSON.parse(JSON.stringify(result)).schemaVersion === '2',
                textProjection: result.targetText === result.blocks.map((block) => block.targetText).join('\n'),
                idempotency: true,
              };
            }),
          );
        }),
      );
    }),
  );
}

export function verifyHostStructuring(context, fixture) {
  // The installed fake completes host-mode requests immediately, like its UI flow.
  return verifyRuntimeCapture(context, fixture, 'host');
}

function fixtureKind(fixture) {
  return fixture.mediaType === 'application/pdf' ? 'pdf'
    : fixture.mediaType.startsWith('audio/') ? 'audio' : 'image';
}

export function validateReady(response) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'apiVersion',
    'capabilities',
    'captureDocumentSchemaVersion',
    'contractSetVersion',
    'message',
    'ocrCompute',
    'ready',
    'runtimeVersion',
    'service',
  ]);
  assert.equal(response.body.service, 'capture-runtime');
  assert.equal(response.body.apiVersion, '2.0');
  assert.equal(response.body.captureDocumentSchemaVersion, schemaVersion);
  assert.equal(response.body.ready, true);
  assert.equal(response.body.message, null);
  assert.equal(typeof response.body.runtimeVersion, 'string');
  assert.equal(response.body.contractSetVersion, '2');
  assert.deepEqual(response.body.capabilities, {
    captureKinds: ['pdf', 'image', 'audio'],
    structuringModes: ['runtime', 'host'],
    supportsCancellation: true, supportsRawDiagnostics: true, maxUploadBytes,
  });
  const compute = response.body.ocrCompute;
  assert.deepEqual(Object.keys(compute).sort(), [
    'adapterClass', 'apiVersion', 'contractSetVersion', 'contractSha256', 'mode',
    'noticeCode', 'reasonCode', 'runtimeVersion', 'schemaVersion', 'service',
    'userNoticeRequired', 'workerSha256',
  ]);
  assert.equal(compute.apiVersion, '2.0');
  assert.equal(compute.schemaVersion, '1');
  assert.equal(compute.service, 'capture-runtime');
  assert.equal(compute.runtimeVersion, response.body.runtimeVersion);
  assert.equal(compute.contractSetVersion, '2');
  assert.match(compute.contractSha256, /^[0-9a-f]{64}$/u);
  assert.match(compute.workerSha256, /^[0-9a-f]{64}$/u);
  assert.equal(compute.mode, 'cpu-fallback');
  assert.equal(compute.adapterClass, 'unknown');
  assert.equal(compute.reasonCode, 'no_compatible_gpu');
  assert.equal(compute.userNoticeRequired, true);
  assert.equal(compute.noticeCode, 'ocr_cpu_fallback');
}

function validateJob(response, expectedStatus, ingestionId, kind) {
  assert.equal(response.status, expectedStatus);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'captureId', 'completedAt', 'createdAt', 'error', 'ingestionId', 'kind',
    'lastEventSequence', 'partialRevision', 'progress', 'protocolVersion',
    'source', 'status', 'updatedAt',
  ]);
  assert.equal(typeof response.body.captureId, 'string');
  assert.equal(response.body.protocolVersion, '2');
  assert.equal(response.body.ingestionId, ingestionId);
  assert.equal(response.body.kind, kind);
  assert.equal(response.body.status, 'completed');
  assert.equal(response.body.progress, 1);
  assert.equal(response.body.partialRevision, 0);
  assert.equal(response.body.lastEventSequence, 1);
  assert.equal(response.body.error, null);
  assertJobTimestamps(response.body);
}

function validateRaw(fixture, response) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'createdAt',
    'diagnosticOnly',
    'extractionEngine',
    'schemaVersion',
    'segments',
    'source',
    'sourceText',
    'warnings',
  ]);
  assert.equal(response.body.schemaVersion, schemaVersion);
  assert.equal(response.body.diagnosticOnly, true);
  assert.equal(response.body.source.fileName, fixture.fileName);
  assert.equal(response.body.source.mediaType, fixture.mediaType);
  assert.equal(response.body.source.bytes, fixture.content.length);
  assert.equal(response.body.source.sha256, sha256(fixture.content));
  assert.equal(response.body.segments.length, fixture.expectedSegments);
  response.body.segments.forEach((segment, index) => {
    assert.deepEqual(Object.keys(segment).sort(), [
      'locator',
      'order',
      'segmentId',
      'text',
    ]);
    assert.equal(segment.order, index);
    assert.equal(segment.locator.kind, fixture.locatorKind);
    if (fixture.locatorKind === 'page') {
      assert.equal(segment.locator.page, index + 1);
    } else {
      assert.equal(segment.locator.startMs, index * 1000);
      assert.equal(segment.locator.endMs, (index + 1) * 1000);
    }
  });
  assert.equal(
    response.body.sourceText,
    response.body.segments.map((segment) => segment.text).join('\n'),
  );
  assert.match(response.body.extractionEngine.digest, /^sha256:[0-9a-f]{64}$/u);
}

function validateResult(fixture, raw, response, targetLanguage) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'blocks',
    'completedAt',
    'createdAt',
    'extractionEngine',
    'rawSegments',
    'schemaVersion',
    'source',
    'sourceText',
    'structuringEngine',
    'targetText',
    'warnings',
  ]);
  assert.equal(response.body.schemaVersion, schemaVersion);
  assert.deepEqual(response.body.source, raw.source);
  assert.deepEqual(response.body.rawSegments, raw.segments);
  assert.equal(response.body.blocks.length, fixture.expectedSegments);
  response.body.blocks.forEach((block, index) => {
    assert.equal(block.order, index);
    assert.equal(block.sourceSegmentId, raw.segments[index].segmentId);
    assert.deepEqual(block.locator, raw.segments[index].locator);
    assert.equal(block.sourceText, raw.segments[index].text);
    assert.equal(block.targetText, `[${targetLanguage}] ${block.sourceText}`);
  });
  assert.equal(response.body.sourceText, raw.sourceText);
  assert.equal(
    response.body.targetText,
    response.body.blocks.map((block) => block.targetText).join('\n'),
  );
  assert.match(response.body.structuringEngine.digest, /^sha256:[0-9a-f]{64}$/u);
}

function assertApiError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(response.body), ['error']);
  assert.equal(response.body.error.code, code);
  assert.equal(typeof response.body.error.message, 'string');
}

function assertJobTimestamps(job) {
  assert.equal(typeof job.createdAt, 'string');
  assert.equal(typeof job.updatedAt, 'string');
  if (job.completedAt !== null && job.completedAt !== undefined) {
    assert.equal(typeof job.completedAt, 'string');
  }
}

export function waitForReady(context) {
  const deadline = Date.now() + 10_000;
  return timer(0, 50).pipe(
    takeWhile(() => Date.now() < deadline),
    exhaustMap(() => {
      if (context.child.exitCode !== null || context.child.signalCode != null) {
        return throwError(() => new Error('Deterministic runtime exited before readiness.'));
      }
      return requestJson(context).pipe(catchError(() => of(undefined)));
    }),
    filter((response) => response?.status === 200 && response.body?.ready === true),
    take(1),
    defaultIfEmpty(undefined),
    concatMap((response) =>
      response
        ? of(response)
        : throwError(() => new Error('Deterministic runtime readiness timed out.')),
    ),
  );
}

// Native HTTP JSON is the deliberate Node boundary; domain callers validate each response.
function requestJson({
  runtimePort,
  host,
  origin,
  token,
  method = 'GET',
  path = '/v2/health/ready',
  headers = {},
  body = Buffer.alloc(0),
}): Observable<{ status: number; headers: http.IncomingHttpHeaders; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return new Observable((subscriber) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: runtimePort,
        method,
        path,
        headers: {
          host,
          ...(origin ? { origin } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
          'content-length': payload.length,
          connection: 'close',
        },
      },
      (response) => {
        response.on('aborted', () => subscriber.error(new Error('Deterministic HTTP response was aborted.')));
        response.on('error', (error) => subscriber.error(error));
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            subscriber.next({
              status: response.statusCode,
              headers: response.headers,
              body: text ? JSON.parse(text) : {},
            });
            subscriber.complete();
          } catch (error) {
            subscriber.error(error);
          }
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error('Deterministic HTTP request timed out.')));
    request.on('error', (error) => subscriber.error(error));
    request.end(payload);
    return () => request.destroy();
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function differentPort(port) {
  return port === 65_535 ? port - 1 : port + 1;
}
