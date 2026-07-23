import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { join, resolve } from 'node:path';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import {
  DETERMINISTIC_FIXTURES,
  DETERMINISTIC_MAX_UPLOAD_BYTES,
  DETERMINISTIC_SCHEMA_VERSION,
} from './constants/deterministic.ts';
import { appRoot, stagedExecutable } from './stage-runtime.ts';
import { assertRedactedEvidence } from './package-qa.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const outputDirectory = join(
  workspaceRoot,
  'tmp',
  'capture-workbench-desktop',
  'smoke',
);
const runtimeData = join(outputDirectory, 'runtime-data');
const maxUploadBytes = DETERMINISTIC_MAX_UPLOAD_BYTES;
const schemaVersion = DETERMINISTIC_SCHEMA_VERSION;
const fixtures = DETERMINISTIC_FIXTURES;

export async function runDeterministicSmoke() {
  await assertStagedRuntime('deterministic');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(join(runtimeData, 'ollama', 'models'), { recursive: true });
  const launched = await launchReadyRuntime();
  const { child, ready, runtimePort, ollamaPort, token, host, origin } = launched;

  try {
    validateReady(ready);
    const policyEvidence = await verifyRequestPolicy({
      runtimePort,
      host,
      origin,
      token,
    });
    const requirementEvidence = await verifyRequirements({
      runtimePort,
      host,
      origin,
      token,
    });
    const captures = [];
    for (const fixture of fixtures) {
      captures.push(
        await verifyRuntimeCapture(
          { runtimePort, host, origin, token },
          fixture,
        ),
      );
    }
    const hostStructuring = await verifyHostStructuring(
      { runtimePort, host, origin, token },
      fixtures[1],
    );

    const report = {
      evidenceKind: 'deterministic-sidecar-smoke',
      releaseGateSatisfied: false,
      canonicalWire: {
        apiVersion: '1.0',
        schemaVersion,
        captureRequest: 'multipart/form-data',
        captureIdField: true,
        rawDiagnosticOnly: true,
      },
      runtimePortIsDynamic: runtimePort > 0,
      ollamaPortIsIndependent: ollamaPort !== runtimePort,
      maxUploadBytes,
      authentication: policyEvidence,
      requirements: requirementEvidence,
      captures,
      hostStructuring,
      disclaimer:
        'Deterministic fixture only; packaged UI automation and real OCR/STT/Ollama clean-install evidence are separate release gates.',
    };
    assertRedactedEvidence(report);
    const reportPath = join(outputDirectory, 'smoke.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { report, reportPath };
  } finally {
    await terminateOwnedTree(child);
  }
}

async function launchReadyRuntime() {
  const failures = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const runtimePort = await reservePort();
    const ollamaPort = await reservePort(runtimePort);
    const token = randomBytes(32).toString('hex');
    const host = `127.0.0.1:${runtimePort}`;
    const origin = 'http://tauri.localhost';
    const child = spawn(
      stagedExecutable,
      ['serve', '--host', '127.0.0.1', '--port', String(runtimePort)],
      {
        cwd: resolve(stagedExecutable, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          CAPTURE_HOST: '127.0.0.1',
          CAPTURE_PORT: String(runtimePort),
          CAPTURE_API_TOKEN: token,
          CAPTURE_ALLOWED_HOSTS: host,
          CAPTURE_ALLOWED_ORIGINS: origin,
          CAPTURE_ENABLE_API_DOCS: 'false',
          CAPTURE_APP_DATA_DIR: join(runtimeData, 'capture'),
          CAPTURE_STRUCTURING_PROVIDER: 'fake',
          CAPTURE_RETENTION_HOURS: '24',
          CAPTURE_MAX_UPLOAD_BYTES: String(maxUploadBytes),
          CAPTURE_OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
          CAPTURE_OLLAMA_APP_DATA: join(runtimeData, 'ollama'),
          CAPTURE_OLLAMA_PID_FILE: join(runtimeData, 'ollama', 'ollama.pid'),
          CAPTURE_OLLAMA_MODEL: 'qwen3.5:4b',
          CAPTURE_OLLAMA_PROFILE_ID:
            'capture-workbench-qwen3.5-4b-structure-v1',
          OLLAMA_HOST: `127.0.0.1:${ollamaPort}`,
          OLLAMA_MODELS: join(runtimeData, 'ollama', 'models'),
        },
      },
    );
    const output = captureChildOutput(child);
    try {
      const ready = await waitForReady({ runtimePort, host, origin, token, child });
      return { child, ready, runtimePort, ollamaPort, token, host, origin };
    } catch (error) {
      await terminateOwnedTree(child);
      const childOutput = redactChildOutput(output.text(), token);
      failures.push(
        `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}` +
          (childOutput ? `; child output: ${childOutput}` : ''),
      );
    }
  }
  throw new Error(
    `Deterministic runtime failed readiness after 3 owned launch attempts: ${failures.join(' | ')}`,
  );
}

function redactChildOutput(value, token) {
  return value
    .replaceAll(token, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [redacted]');
}

function captureChildOutput(child) {
  const chunks = [];
  const collect = (chunk) => {
    if (chunks.reduce((total, item) => total + item.length, 0) < 8_192) {
      chunks.push(Buffer.from(chunk));
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return {
    text: () => Buffer.concat(chunks).toString('utf8').trim().slice(0, 8_192),
  };
}

async function verifyRequestPolicy(context) {
  const unauthorized = await requestJson({
    ...context,
    token: undefined,
  });
  assertApiError(unauthorized, 401, 'unauthorized');
  assert.equal(unauthorized.headers['www-authenticate'], 'Bearer');

  const rejectedOrigin = await requestJson({
    ...context,
    origin: 'https://untrusted.invalid',
  });
  assertApiError(rejectedOrigin, 403, 'origin_not_allowed');
  assert.equal(rejectedOrigin.headers['access-control-allow-origin'], undefined);

  const rejectedHostName = await requestJson({
    ...context,
    host: `localhost:${context.runtimePort}`,
  });
  assertApiError(rejectedHostName, 400, 'invalid_host');

  const rejectedHostPort = await requestJson({
    ...context,
    host: `127.0.0.1:${differentPort(context.runtimePort)}`,
  });
  assertApiError(rejectedHostPort, 400, 'invalid_host');

  const preflight = await requestJson({
    ...context,
    token: undefined,
    method: 'OPTIONS',
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers':
        'authorization,content-type,x-idempotency-key',
    },
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers['access-control-allow-origin'], context.origin);
  assert.match(preflight.headers['access-control-allow-methods'], /DELETE/u);
  assert.match(
    preflight.headers['access-control-allow-headers'],
    /X-Idempotency-Key/u,
  );

  return {
    unauthorized: unauthorized.status,
    originRejected: rejectedOrigin.status,
    hostNameRejected: rejectedHostName.status,
    wrongAuthorityPortRejected: rejectedHostPort.status,
    preflight: preflight.status,
  };
}

async function verifyRequirements(context) {
  const requirements = await requestJson({
    ...context,
    path: '/v1/runtime/requirements',
  });
  assert.equal(requirements.status, 200);
  const requirementIds = requirements.body.items.map(
    (item) => item.requirementId,
  );
  assert.deepEqual(requirementIds, [
    'windowsml-ocr',
    'whisper-primary',
    'ollama-runtime',
    'capture-ollama-model',
  ]);

  const installationKey = randomUUID();
  const installationPayload = JSON.stringify({
    requirementId: 'whisper-primary',
    consent: true,
  });
  const installation = await requestJson({
    ...context,
    method: 'POST',
    path: '/v1/runtime/installations',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': installationKey,
    },
    body: installationPayload,
  });
  assert.equal(installation.status, 202);
  assert.equal(installation.body.requirementId, 'whisper-primary');
  assert.equal(typeof installation.body.installationId, 'string');
  assertJobTimestamps(installation.body);

  const repeated = await requestJson({
    ...context,
    method: 'POST',
    path: '/v1/runtime/installations',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': installationKey,
    },
    body: installationPayload,
  });
  assert.equal(repeated.body.installationId, installation.body.installationId);

  return { requirementIds, installationIdempotency: true };
}

async function verifyRuntimeCapture(context, fixture) {
  const idempotencyKey = randomUUID();
  const request = captureRequest(fixture, 'runtime', 'zh-TW');
  const created = await requestJson({
    ...context,
    method: 'POST',
    path: '/v1/captures',
    headers: {
      'content-type': request.contentType,
      'x-idempotency-key': idempotencyKey,
    },
    body: request.body,
  });
  validateJob(created, 202, {
    status: 'completed',
    stage: 'completed',
    mode: 'runtime',
  });
  const captureId = created.body.captureId;

  const repeated = await requestJson({
    ...context,
    method: 'POST',
    path: '/v1/captures',
    headers: {
      'content-type': request.contentType,
      'x-idempotency-key': idempotencyKey,
    },
    body: request.body,
  });
  assert.equal(repeated.status, 202);
  assert.equal(repeated.body.captureId, captureId);

  const changed = captureRequest(
    { ...fixture, content: Buffer.concat([fixture.content, Buffer.from('changed')]) },
    'runtime',
    'zh-TW',
  );
  const conflict = await requestJson({
    ...context,
    method: 'POST',
    path: '/v1/captures',
    headers: {
      'content-type': changed.contentType,
      'x-idempotency-key': idempotencyKey,
    },
    body: changed.body,
  });
  assertApiError(conflict, 409, 'idempotency_conflict');

  const status = await requestJson({
    ...context,
    path: `/v1/captures/${captureId}`,
  });
  validateJob(status, 200, {
    status: 'completed',
    stage: 'completed',
    mode: 'runtime',
  });

  const raw = await requestJson({
    ...context,
    path: `/v1/captures/${captureId}/raw`,
  });
  validateRaw(fixture, raw);
  const result = await requestJson({
    ...context,
    path: `/v1/captures/${captureId}/result`,
  });
  validateResult(fixture, raw.body, result, 'zh-TW');

  return {
    fileName: fixture.fileName,
    captureId,
    locatorKind: result.body.blocks[0].locator.kind,
    segments: result.body.rawSegments.length,
    jsonReparsed: JSON.parse(JSON.stringify(result.body)).schemaVersion === '1',
    textProjection: result.body.targetText ===
      result.body.blocks.map((block) => block.targetText).join('\n'),
    idempotency: true,
  };
}

async function verifyHostStructuring(context, fixture) {
  const awaiting = await createHostCapture(context, fixture);
  const captureId = awaiting.body.captureId;
  const unavailable = await requestJson({
    ...context,
    path: `/v1/captures/${captureId}/result`,
  });
  assertApiError(unavailable, 409, 'result_unavailable');
  const raw = await requestJson({
    ...context,
    path: `/v1/captures/${captureId}/raw`,
  });
  validateRaw(fixture, raw);

  const candidate = hostCandidate(raw.body);
  const structured = await requestJson({
    ...context,
    method: 'POST',
    path: `/v1/captures/${captureId}/structure`,
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': randomUUID(),
    },
    body: JSON.stringify(candidate),
  });
  validateJob(structured, 200, {
    status: 'completed',
    stage: 'completed',
    mode: 'host',
  });
  const result = await requestJson({
    ...context,
    path: `/v1/captures/${captureId}/result`,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, candidate);

  const failedCapture = await createHostCapture(context, fixtures[0]);
  const failedId = failedCapture.body.captureId;
  const failed = await requestJson({
    ...context,
    method: 'POST',
    path: `/v1/captures/${failedId}/structuring-failure`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: 'invalid_provider_json',
      message: 'Provider returned invalid JSON.',
    }),
  });
  validateJob(failed, 200, {
    status: 'failed',
    stage: 'failed',
    mode: 'host',
  });
  assert.deepEqual(failed.body.error, {
    code: 'invalid_provider_json',
    message: 'Provider returned invalid JSON.',
    stage: 'structuring',
    retryable: false,
  });
  const failedResult = await requestJson({
    ...context,
    path: `/v1/captures/${failedId}/result`,
  });
  assertApiError(failedResult, 409, 'result_unavailable');
  const diagnostic = await requestJson({
    ...context,
    path: `/v1/captures/${failedId}/raw`,
  });
  assert.equal(diagnostic.status, 200);
  assert.equal(diagnostic.body.diagnosticOnly, true);

  return {
    completedCaptureId: captureId,
    failedCaptureId: failedId,
    unavailableResultEnvelope: true,
    diagnosticRawAfterFailure: true,
  };
}

async function createHostCapture(context, fixture) {
  const request = captureRequest(fixture, 'host');
  const response = await requestJson({
    ...context,
    method: 'POST',
    path: '/v1/captures',
    headers: {
      'content-type': request.contentType,
      'x-idempotency-key': randomUUID(),
    },
    body: request.body,
  });
  validateJob(response, 202, {
    status: 'running',
    stage: 'awaiting_structuring',
    mode: 'host',
  });
  return response;
}

function validateReady(response) {
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

async function waitForReady(context) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (context.child.exitCode !== null) {
      throw new Error('Deterministic runtime exited before readiness.');
    }
    const response = await requestJson(context).catch(() => undefined);
    if (response?.status === 200 && response.body?.ready === true) {
      return response;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error('Deterministic runtime readiness timed out.');
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
}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return new Promise((resolvePromise, reject) => {
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
            resolvePromise({
              status: response.statusCode,
              headers: response.headers,
              body: text ? JSON.parse(text) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function differentPort(port) {
  return port === 65_535 ? port - 1 : port + 1;
}

function reservePort(excluded) {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port === 0 || port === excluded) {
          reservePort(excluded).then(resolvePromise, reject);
        } else {
          resolvePromise(port);
        }
      });
    });
  });
}

async function terminateOwnedTree(child) {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
}

runDeterministicSmoke()
  .then(({ reportPath }) => {
    process.stdout.write(`Deterministic sidecar smoke report: ${reportPath}\n`);
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
