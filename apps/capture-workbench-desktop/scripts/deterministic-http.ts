import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import {
  Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  filter,
  from,
  map,
  of,
  take,
  takeWhile,
  tap,
  throwError,
  timer,
  toArray,
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
  const ingestionKey = randomUUID();
  const captureKey = randomUUID();
  return openIngestion(context, ingestionKey, fixture).pipe(
    tap((ingestion) => validateIngestion(ingestion, fixture)),
    concatMap((ingestion) => {
      const ingestionId = ingestion.body.ingestionId;
      return uploadChunks(context, ingestionId, fixture).pipe(
        tap((chunks) => {
          assert.equal(chunks.length, chunkCount(fixture));
          chunks.forEach((chunk) => assert.equal(chunk.status, 200));
        }),
        concatMap(() => finalizeIngestion(context, ingestionId, fixture)),
        tap((finalized) => {
          assert.equal(finalized.status, 200);
          assert.equal(finalized.body.status, 'ready');
          assert.equal(finalized.body.finalizedSha256, sha256(fixture.content));
        }),
        concatMap((finalized) =>
          startCapture(
            context,
            captureKey,
            finalized.body.ingestionId,
            fixture,
            'runtime',
            'zh-TW',
          ),
        ),
        tap((created) => validateOperation(created, 202, { status: 'completed' })),
        concatMap((created) => {
          const captureId = created.body.captureId;
          return startCapture(context, captureKey, ingestionId, fixture, 'runtime', 'zh-TW').pipe(
            tap((repeated) => {
              assert.equal(repeated.status, 202);
              assert.equal(repeated.body.captureId, captureId);
            }),
            concatMap(() =>
              startCapture(context, captureKey, ingestionId, fixture, 'host'),
            ),
            tap((conflict) => assertApiError(conflict, 409, 'idempotency_conflict')),
            concatMap(() => requestJson({ ...context, path: `/v2/captures/${captureId}` })),
            tap((status) => validateOperation(status, 200, { status: 'completed' })),
            concatMap(() => requestJson({ ...context, path: `/v2/captures/${captureId}/events` })),
            tap((events) =>
              validateEvents(events, captureId, ['accepted', 'checkpoint', 'completed'], [1, 2, 3]),
            ),
            concatMap(() =>
              requestJson({
                ...context,
                path: `/v2/captures/${captureId}/events`,
                headers: { 'Last-Event-ID': 'not-a-number' },
              }),
            ),
            tap((invalidCursor) =>
              assertApiError(invalidCursor, 422, 'invalid_event_cursor'),
            ),
            concatMap(() =>
              requestJson({
                ...context,
                path: `/v2/captures/${captureId}/events`,
                headers: { 'Last-Event-ID': '1' },
              }),
            ),
            tap((cursored) => {
              validateEvents(cursored, captureId, ['checkpoint', 'completed'], [2, 3]);
            }),
            concatMap(() =>
              requestJson({
                ...context,
                path: `/v2/captures/${captureId}/events`,
                headers: { 'Last-Event-ID': '0' },
              }),
            ),
            tap((resync) => validateResyncEvent(resync, captureId, 3)),
            concatMap(() => requestJson({ ...context, path: `/v2/captures/${captureId}/result` })),
            concatMap((terminal) => {
              validateTerminal(terminal, fixture, 'zh-TW');
              return requestJson({ ...context, path: `/v2/captures/${captureId}/partial` }).pipe(
                tap((partial) => validatePartial(partial, fixture, captureId)),
                map(() => ({
                  fileName: fixture.fileName,
                  captureId,
                  locatorKind: terminal.body.result.blocks[0].locator.kind,
                  segments: terminal.body.result.rawSegments.length,
                  jsonReparsed:
                    JSON.parse(JSON.stringify(terminal.body.result)).schemaVersion === '1',
                  textProjection:
                    terminal.body.result.targetText ===
                    terminal.body.result.blocks.map((block) => block.targetText).join('\n'),
                  idempotency: true,
                })),
              );
            }),
            concatMap((summary) =>
              requestJson({ ...context, method: 'DELETE', path: `/v2/captures/${captureId}` }).pipe(
                tap((deleted) => assert.equal(deleted.status, 204)),
                concatMap(() =>
                  requestJson({
                    ...context,
                    method: 'DELETE',
                    path: `/v2/ingestions/${ingestionId}`,
                  }),
                ),
                tap((deletedIngestion) =>
                  assert.ok([204, 404].includes(deletedIngestion.status)),
                ),
                map(() => summary),
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
      const ingestionId = awaiting.body.ingestionId;
      return requestJson({ ...context, path: `/v2/captures/${captureId}/result` }).pipe(
        tap((unavailable) => assertApiError(unavailable, 409, 'result_unavailable')),
        concatMap(() =>
          requestJson({
            ...context,
            method: 'DELETE',
            path: `/v2/captures/${captureId}`,
          }),
        ),
        tap((activeDelete) =>
          assertApiError(activeDelete, 409, 'capture_delete_rejected'),
        ),
        concatMap(() =>
          requestJson({
            ...context,
            method: 'POST',
            path: `/v2/captures/${captureId}/structure`,
          }),
        ),
        tap((invalid) => assertApiError(invalid, 409, 'invalid_capture_state')),
        concatMap(() => {
          const candidate = hostCandidate(fixtureRaw(fixture));
          return requestJson({
            ...context,
            method: 'POST',
            path: `/v2/captures/${captureId}/structure/commit`,
            headers: { 'content-type': 'application/json', 'x-idempotency-key': randomUUID() },
            body: JSON.stringify(candidate),
          }).pipe(
            tap((structured) =>
              validateOperation(structured, 200, { status: 'completed' }),
            ),
            concatMap(() => requestJson({ ...context, path: `/v2/captures/${captureId}/result` })),
            tap((result) => {
              assert.equal(result.status, 200);
              assert.deepEqual(result.body.result, candidate);
            }),
            concatMap(() => cleanupCapture(context, captureId, ingestionId)),
            concatMap(() => createHostCapture(context, fixtures[0])),
            concatMap((failedCapture) => {
              const failedId = failedCapture.body.captureId;
              const failedIngestionId = failedCapture.body.ingestionId;
              return requestJson({
                ...context,
                method: 'POST',
                path: `/v2/captures/${failedId}/structure/failure`,
                headers: {
                  'content-type': 'application/json',
                  'x-idempotency-key': randomUUID(),
                },
                body: JSON.stringify({
                  code: 'access_token_deterministic_secret',
                  message: 'Bearer deterministic-secret',
                }),
              }).pipe(
                tap((failed) => {
                  validateOperation(failed, 200, { status: 'failed' });
                  assert.deepEqual(failed.body.error, {
                    code: 'host_provider_failed',
                    message: 'Host structuring failed.',
                    stage: 'structuring',
                    retryable: false,
                  });
                  assert.doesNotMatch(JSON.stringify(failed.body), /deterministic-secret/u);
                }),
                concatMap(() => requestJson({ ...context, path: `/v2/captures/${failedId}/result` })),
                tap((failedResult) => assertApiError(failedResult, 409, 'result_unavailable')),
                concatMap(() => cleanupCapture(context, failedId, failedIngestionId)),
                map(() => {
                  return {
                    completedCaptureId: captureId,
                    failedCaptureId: failedId,
                    unavailableResultEnvelope: true,
                    hostCommitValidated: true,
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
  return openIngestion(context, randomUUID(), fixture).pipe(
    concatMap((ingestion) => {
      const ingestionId = ingestion.body.ingestionId;
      return uploadChunks(context, ingestionId, fixture).pipe(
        concatMap(() => finalizeIngestion(context, ingestionId, fixture)),
        concatMap((finalized) =>
          startCapture(context, randomUUID(), finalized.body.ingestionId, fixture, 'host'),
        ),
        tap((response) => validateOperation(response, 202, { status: 'awaiting_structuring' })),
      );
    }),
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

function validateIngestion(response, fixture) {
  assert.equal(response.status, 201);
  assert.equal(response.body.protocolVersion, '2');
  assert.equal(response.body.status, 'open');
  assert.equal(response.body.kind, mediaKind(fixture));
  assert.equal(response.body.fileName, fixture.fileName);
  assert.equal(response.body.mediaType, fixture.mediaType);
  assert.equal(response.body.totalBytes, fixture.content.length);
  assert.equal(response.body.receivedBytes, 0);
  assert.equal(response.body.nextChunkIndex, 0);
  assert.equal(response.body.nextOffset, 0);
  assert.equal(response.body.sourceSha256, sha256(fixture.content));
  assert.equal(typeof response.body.ingestionId, 'string');
  assert.equal(typeof response.body.expiresAt, 'string');
}

function validateOperation(response, expectedStatus, expected) {
  assert.equal(response.status, expectedStatus);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'captureId',
    'completedAt',
    'createdAt',
    'error',
    'ingestionId',
    'kind',
    'lastEventSequence',
    'partialRevision',
    'progress',
    'protocolVersion',
    'source',
    'status',
    'updatedAt',
  ]);
  assert.equal(response.body.protocolVersion, '2');
  assert.equal(typeof response.body.captureId, 'string');
  assert.equal(typeof response.body.ingestionId, 'string');
  assert.equal(response.body.status, expected.status);
  assert.equal(typeof response.body.progress, 'number');
  assertJobTimestamps(response.body);
}

export interface DeterministicSseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

export function parseSseFrames(text: string): readonly DeterministicSseFrame[] {
  const frames: DeterministicSseFrame[] = [];
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const dispatch = () => {
    if (id !== undefined || event !== undefined || data.length > 0) {
      const frame: { id?: string; event?: string; data: string } = { data: data.join('\n') };
      if (id !== undefined) {
        frame.id = id;
      }
      if (event !== undefined) {
        frame.event = event;
      }
      frames.push(frame);
    }
    id = undefined;
    event = undefined;
    data = [];
  };

  const normalized = text.replace(/\r\n?/gu, '\n');
  const incompletePhysicalLine = normalized.length > 0 && !normalized.endsWith('\n');
  for (const line of normalized.split('\n')) {
    if (line === '') {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'id') {
      id = value;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }
  const pending = id !== undefined || event !== undefined || data.length > 0;
  dispatch();
  if (pending || incompletePhysicalLine) {
    throw new Error('Deterministic SSE response ended with an incomplete event frame.');
  }
  return frames;
}

function validateEvents(response, captureId, expectedTypes, expectedSequences) {
  assert.equal(response.status, 200);
  assert.match(responseContentType(response.headers).toLowerCase(), /^text\/event-stream(?:;|$)/u);
  assert.equal(response.headers.connection, 'close');
  assert.equal(typeof response.body, 'string');
  const frames = parseSseFrames(response.body);
  const events = frames.map((frame) => JSON.parse(frame.data));
  assert.deepEqual(
    events.map((event) => event.eventType),
    expectedTypes,
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    expectedSequences,
  );
  assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
  events.forEach((event, index) => {
    const frame = frames[index];
    assert.equal(event.protocolVersion, '2');
    assert.equal(frame.id, String(event.sequence));
    assert.equal(frame.event, event.eventType);
    assert.equal(event.captureId, captureId);
    assert.equal(event.eventId, `${captureId}/${event.sequence}`);
    assert.equal(typeof event.createdAt, 'string');
    if (index > 0) {
      assert.ok(event.sequence > events[index - 1].sequence);
    }
  });
  assert.ok(events.length > 0);
  const lastEvent = events[events.length - 1];
  const lastFrame = frames[frames.length - 1];
  assert.ok(['completed', 'failed', 'cancelled'].includes(lastEvent.eventType));
  assert.equal(lastFrame.event, lastEvent.eventType);
}

function validateResyncEvent(response, captureId, expectedSequence) {
  assert.equal(response.status, 200);
  assert.match(responseContentType(response.headers).toLowerCase(), /^text\/event-stream(?:;|$)/u);
  assert.equal(response.headers.connection, 'close');
  assert.equal(typeof response.body, 'string');
  const frames = parseSseFrames(response.body);
  assert.equal(frames.length, 1);
  const [frame] = frames;
  const event = JSON.parse(frame.data);
  assert.equal(frame.id, String(expectedSequence));
  assert.equal(frame.event, 'resync_required');
  assert.equal(event.protocolVersion, '2');
  assert.equal(event.captureId, captureId);
  assert.equal(event.sequence, expectedSequence);
  assert.equal(event.eventId, `${captureId}/${expectedSequence}`);
  assert.equal(event.eventType, 'resync_required');
  assert.equal(event.stage, 'resync');
}

function validatePartial(response, fixture, captureId) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'captureId',
    'coveredUntilMs',
    'extractionEngine',
    'protocolVersion',
    'revision',
    'segments',
    'source',
    'sourceText',
    'updatedAt',
  ]);
  assert.equal(response.body.protocolVersion, '2');
  assert.equal(response.body.captureId, captureId);
  assert.equal(response.body.revision, 1);
  assert.equal(response.body.source.fileName, fixture.fileName);
  assert.equal(response.body.source.mediaType, fixture.mediaType);
  assert.equal(response.body.source.bytes, fixture.content.length);
  assert.equal(response.body.source.sha256, sha256(fixture.content));
  assert.equal(response.body.segments.length, fixture.expectedSegments);
  assert.equal(
    response.body.coveredUntilMs,
    fixture.locatorKind === 'time' ? fixture.expectedSegments * 1000 : 0,
  );
  assert.equal(
    response.body.sourceText,
    response.body.segments.map((segment) => segment.text).join('\n'),
  );
  assert.match(response.body.extractionEngine.digest, /^sha256:[0-9a-f]{64}$/u);
}

function validateTerminal(response, fixture, targetLanguage) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['operation', 'raw', 'result']);
  validateOperation({ status: 200, body: response.body.operation }, 200, {
    status: 'completed',
  });
  validateRaw(fixture, { status: 200, body: response.body.raw });
  validateResult(
    fixture,
    response.body.raw,
    { status: 200, body: response.body.result },
    targetLanguage,
  );
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

function mediaKind(fixture) {
  if (fixture.mediaType === 'application/pdf') return 'pdf';
  if (fixture.mediaType.startsWith('image/')) return 'image';
  if (fixture.mediaType.startsWith('audio/')) return 'audio';
  throw new Error(`Unsupported deterministic fixture media type: ${fixture.mediaType}`);
}

function chunkCount(fixture) {
  return Math.ceil(fixture.content.length / (1024 * 1024));
}

function openIngestion(context, clientRequestId, fixture) {
  return requestJson({
    ...context,
    method: 'POST',
    path: '/v2/ingestions',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId,
      kind: mediaKind(fixture),
      mode: 'file',
      fileName: fixture.fileName,
      mediaType: fixture.mediaType,
      totalBytes: fixture.content.length,
      sourceSha256: sha256(fixture.content),
    }),
  });
}

function uploadChunks(context, ingestionId, fixture) {
  return from(Array.from({ length: chunkCount(fixture) }, (_, index) => index)).pipe(
    concatMap((index) => {
      const start = index * 1024 * 1024;
      const end = Math.min(fixture.content.length, start + 1024 * 1024);
      const chunk = fixture.content.subarray(start, end);
      return requestJson({
        ...context,
        method: 'PUT',
        path: `/v2/ingestions/${ingestionId}/chunks/${index}`,
        headers: {
          'Content-Range': `bytes ${start}-${end - 1}/${fixture.content.length}`,
          Digest: `sha-256=${createHash('sha256').update(chunk).digest('hex')}`,
          'X-Idempotency-Key': `deterministic-${index}`,
        },
          body: chunk,
      });
    }),
    toArray(),
  );
}

function finalizeIngestion(context, ingestionId, fixture) {
  return requestJson({
    ...context,
    method: 'POST',
    path: `/v2/ingestions/${ingestionId}/finalize`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      totalBytes: fixture.content.length,
      sha256: sha256(fixture.content),
    }),
  });
}

function startCapture(
  context,
  clientRequestId,
  ingestionId,
  fixture,
  structuringMode,
  targetLanguage = undefined,
) {
  return requestJson({
    ...context,
    method: 'POST',
    path: '/v2/captures',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId,
      ingestionId,
      structuringMode,
      startPolicy: 'eager',
      ...(targetLanguage ? { targetLanguage } : {}),
    }),
  });
}

function fixtureRaw(fixture) {
  const sourceSha256 = sha256(fixture.content);
  const kind = mediaKind(fixture);
  const marker = Buffer.from('CAPTURE_TEXT:', 'utf8');
  const index = fixture.content.indexOf(marker);
  let text = '';
  if (index >= 0) {
    text = fixture.content
      .subarray(index + marker.length)
      .toString('utf8')
      .replace(/[\0\r\n ]+$/u, '');
  }
  if (!text) text = `Deterministic ${kind} capture ${sourceSha256.slice(0, 12)}`;
  const parts = text
    .split(kind === 'audio' ? '|' : '\f')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const segments = parts.map((part, order) => ({
    segmentId: `segment-${order + 1}`,
    order,
    locator: kind === 'audio'
      ? { kind: 'time', startMs: order * 1000, endMs: (order + 1) * 1000 }
      : { kind: 'page', page: order + 1 },
    text: part,
  }));
  const [engine, model] = kind === 'audio'
    ? ['whisper-primary', 'deterministic-whisper-v1']
    : ['windowsml-ocr', 'deterministic-windowsml-v1'];
  return {
    schemaVersion,
    diagnosticOnly: true,
    source: {
      sha256: sourceSha256,
      fileName: fixture.fileName,
      mediaType: fixture.mediaType,
      bytes: fixture.content.length,
    },
    segments,
    sourceText: parts.join('\n'),
    extractionEngine: {
      engine,
      model,
      digest: `sha256:${sha256(Buffer.from(`${engine}:${model}`))}`,
      device: 'fake',
    },
    warnings: [],
    createdAt: '2000-01-01T00:00:00Z',
  };
}

function cleanupCapture(context, captureId, ingestionId) {
  return requestJson({
    ...context,
    method: 'DELETE',
    path: `/v2/captures/${captureId}`,
  }).pipe(
    tap((deleted) => assert.equal(deleted.status, 204)),
    concatMap(() =>
      requestJson({
        ...context,
        method: 'DELETE',
        path: `/v2/ingestions/${ingestionId}`,
      }),
    ),
    tap((deletedIngestion) =>
      assert.ok([204, 404].includes(deletedIngestion.status)),
    ),
  );
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
function responseContentType(headers: http.IncomingHttpHeaders): string {
  const value = headers['content-type'];
  return Array.isArray(value) ? value.join(';') : value ?? '';
}

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
            const contentType = responseContentType(response.headers);
            const bytes = Buffer.concat(chunks);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            subscriber.next({
              status: response.statusCode,
              headers: response.headers,
              body: contentType.toLowerCase().startsWith('text/event-stream')
                ? text
                : text
                  ? JSON.parse(text)
                  : {},
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
