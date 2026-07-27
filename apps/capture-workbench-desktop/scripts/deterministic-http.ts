import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import {
  Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  filter,
  map,
  of,
  take,
  takeWhile,
  tap,
  throwError,
  timer,
} from 'rxjs';

import {
  DETERMINISTIC_FIXTURES,
  DETERMINISTIC_MAX_UPLOAD_BYTES,
  DETERMINISTIC_SCHEMA_VERSION,
} from './constants/deterministic.ts';

const maxUploadBytes = DETERMINISTIC_MAX_UPLOAD_BYTES;
const schemaVersion = DETERMINISTIC_SCHEMA_VERSION;
const fixtures = DETERMINISTIC_FIXTURES;

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
  return requestJson({ ...context, path: '/v1/runtime/requirements' }).pipe(
    concatMap((requirements) => {
      assert.equal(requirements.status, 200);
      const requirementIds = requirements.body.items.map((item) => item.requirementId);
      assert.deepEqual(requirementIds, [
        'windowsml-ocr',
        'whisper-primary',
        'ollama-runtime',
        'capture-ollama-model',
      ]);
      const installationKey = randomUUID();
      const installationPayload = JSON.stringify({ requirementId: 'whisper-primary', consent: true });
      return requestJson({
        ...context,
        method: 'POST',
        path: '/v1/runtime/installations',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': installationKey },
        body: installationPayload,
      }).pipe(
        concatMap((installation) => {
          assert.equal(installation.status, 202);
          assert.equal(installation.body.requirementId, 'whisper-primary');
          assert.equal(typeof installation.body.installationId, 'string');
          assertJobTimestamps(installation.body);
          return requestJson({
            ...context,
            method: 'POST',
            path: '/v1/runtime/installations',
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

export function verifyRuntimeCapture(context, fixture) {
  const idempotencyKey = randomUUID();
  const request = captureRequest(fixture, 'runtime', 'zh-TW');
  return requestJson({
    ...context,
    method: 'POST',
    path: '/v1/captures',
    headers: {
      'content-type': request.contentType,
      'x-idempotency-key': idempotencyKey,
    },
    body: request.body,
  }).pipe(
    concatMap((created) => {
      validateJob(created, 202, { status: 'completed', stage: 'completed', mode: 'runtime' });
      const captureId = created.body.captureId;
      return requestJson({
        ...context,
        method: 'POST',
        path: '/v1/captures',
        headers: { 'content-type': request.contentType, 'x-idempotency-key': idempotencyKey },
        body: request.body,
      }).pipe(
        tap((repeated) => {
          assert.equal(repeated.status, 202);
          assert.equal(repeated.body.captureId, captureId);
        }),
        concatMap(() => {
          const changed = captureRequest(
            { ...fixture, content: Buffer.concat([fixture.content, Buffer.from('changed')]) },
            'runtime',
            'zh-TW',
          );
          return requestJson({
            ...context,
            method: 'POST',
            path: '/v1/captures',
            headers: { 'content-type': changed.contentType, 'x-idempotency-key': idempotencyKey },
            body: changed.body,
          }).pipe(
            tap((conflict) => assertApiError(conflict, 409, 'idempotency_conflict')),
            concatMap(() => requestJson({ ...context, path: `/v1/captures/${captureId}` })),
            tap((status) => validateJob(status, 200, { status: 'completed', stage: 'completed', mode: 'runtime' })),
            concatMap(() => requestJson({ ...context, path: `/v1/captures/${captureId}/raw` })),
            tap((raw) => validateRaw(fixture, raw)),
            concatMap((raw) =>
              requestJson({ ...context, path: `/v1/captures/${captureId}/result` }).pipe(
                map((result) => {
                  validateResult(fixture, raw.body, result, 'zh-TW');
                  return {
                    fileName: fixture.fileName,
                    captureId,
                    locatorKind: result.body.blocks[0].locator.kind,
                    segments: result.body.rawSegments.length,
                    jsonReparsed: JSON.parse(JSON.stringify(result.body)).schemaVersion === '1',
                    textProjection: result.body.targetText === result.body.blocks.map((block) => block.targetText).join('\n'),
                    idempotency: true,
                  };
                }),
              ),
            ),
          );
        }),
      );
    }),
  );
}

export function verifyHostStructuring(context, fixture) {
  return createHostCapture(context, fixture).pipe(
    concatMap((awaiting) => {
      const captureId = awaiting.body.captureId;
      return requestJson({ ...context, path: `/v1/captures/${captureId}/result` }).pipe(
        tap((unavailable) => assertApiError(unavailable, 409, 'result_unavailable')),
        concatMap(() => requestJson({ ...context, path: `/v1/captures/${captureId}/raw` })),
        tap((raw) => validateRaw(fixture, raw)),
        concatMap((raw) => {
          const candidate = hostCandidate(raw.body);
          return requestJson({
            ...context,
            method: 'POST',
            path: `/v1/captures/${captureId}/structure`,
            headers: { 'content-type': 'application/json', 'x-idempotency-key': randomUUID() },
            body: JSON.stringify(candidate),
          }).pipe(
            tap((structured) => validateJob(structured, 200, { status: 'completed', stage: 'completed', mode: 'host' })),
            concatMap(() => requestJson({ ...context, path: `/v1/captures/${captureId}/result` })),
            tap((result) => {
              assert.equal(result.status, 200);
              assert.deepEqual(result.body, candidate);
            }),
            concatMap(() => createHostCapture(context, fixtures[0])),
            concatMap((failedCapture) => {
              const failedId = failedCapture.body.captureId;
              return requestJson({
                ...context,
                method: 'POST',
                path: `/v1/captures/${failedId}/structuring-failure`,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code: 'invalid_provider_json', message: 'Provider returned invalid JSON.' }),
              }).pipe(
                tap((failed) => {
                  validateJob(failed, 200, { status: 'failed', stage: 'failed', mode: 'host' });
                  assert.deepEqual(failed.body.error, {
                    code: 'invalid_provider_json',
                    message: 'Provider returned invalid JSON.',
                    stage: 'structuring',
                    retryable: false,
                  });
                }),
                concatMap(() => requestJson({ ...context, path: `/v1/captures/${failedId}/result` })),
                tap((failedResult) => assertApiError(failedResult, 409, 'result_unavailable')),
                concatMap(() => requestJson({ ...context, path: `/v1/captures/${failedId}/raw` })),
                map((diagnostic) => {
                  assert.equal(diagnostic.status, 200);
                  assert.equal(diagnostic.body.diagnosticOnly, true);
                  return {
                    completedCaptureId: captureId,
                    failedCaptureId: failedId,
                    unavailableResultEnvelope: true,
                    diagnosticRawAfterFailure: true,
                  };
                }),
              );
            }),
          );
        }),
      );
    }),
  );
}

function createHostCapture(context, fixture) {
  const request = captureRequest(fixture, 'host');
  return requestJson({
    ...context,
    method: 'POST',
    path: '/v1/captures',
    headers: {
      'content-type': request.contentType,
      'x-idempotency-key': randomUUID(),
    },
    body: request.body,
  }).pipe(
    tap((response) =>
      validateJob(response, 202, {
        status: 'running',
        stage: 'awaiting_structuring',
        mode: 'host',
      }),
    ),
  );
}

export function validateReady(response) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'apiVersion',
    'capabilities',
    'captureDocumentSchemaVersion',
    'message',
    'ready',
    'runtimeVersion',
    'service',
  ]);
  assert.equal(response.body.service, 'capture-runtime');
  assert.equal(response.body.apiVersion, '1.0');
  assert.equal(response.body.captureDocumentSchemaVersion, schemaVersion);
  assert.equal(response.body.capabilities.maxUploadBytes, maxUploadBytes);
}

function validateJob(response, expectedStatus, expected) {
  assert.equal(response.status, expectedStatus);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'captureId',
    'completedAt',
    'createdAt',
    'error',
    'progress',
    'source',
    'stage',
    'status',
    'structuringMode',
    'updatedAt',
  ]);
  assert.equal(typeof response.body.captureId, 'string');
  assert.equal(response.body.status, expected.status);
  assert.equal(response.body.stage, expected.stage);
  assert.equal(response.body.structuringMode, expected.mode);
  assert.equal(typeof response.body.progress, 'number');
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

function hostCandidate(raw) {
  const blocks = raw.segments.map((segment, index) => ({
    blockId: `host-block-${index + 1}`,
    order: index,
    type: segment.locator.kind === 'time' ? 'transcript' : 'paragraph',
    sourceSegmentId: segment.segmentId,
    locator: segment.locator,
    sourceText: segment.text,
    targetText: `[host] ${segment.text}`,
  }));
  return {
    schemaVersion,
    source: raw.source,
    rawSegments: raw.segments,
    blocks,
    sourceText: raw.sourceText,
    targetText: blocks.map((block) => block.targetText).join('\n'),
    extractionEngine: raw.extractionEngine,
    structuringEngine: {
      engine: 'host-fixture',
      model: 'host-fixture-v1',
      digest: `sha256:${sha256(Buffer.from('host-fixture:host-fixture-v1'))}`,
      device: 'fake',
    },
    warnings: raw.warnings,
    createdAt: raw.createdAt,
    completedAt: '2000-01-01T00:00:01Z',
  };
}

function captureRequest(fixture, structuringMode, targetLanguage) {
  const boundary = `capture-workbench-${randomUUID()}`;
  const chunks = [
    field(boundary, 'file', fixture.content, fixture.fileName),
    field(boundary, 'structuringMode', Buffer.from(structuringMode)),
  ];
  if (targetLanguage) {
    chunks.push(field(boundary, 'targetLanguage', Buffer.from(targetLanguage)));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

function field(boundary, name, value, fileName) {
  const disposition = fileName
    ? `Content-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: application/octet-stream`
    : `Content-Disposition: form-data; name="${name}"`;
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n${disposition}\r\n\r\n`, 'utf8'),
    value,
    Buffer.from('\r\n', 'utf8'),
  ]);
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
    concatMap(() => {
      if (context.child.exitCode !== null) {
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
  path = '/v1/health/ready',
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
