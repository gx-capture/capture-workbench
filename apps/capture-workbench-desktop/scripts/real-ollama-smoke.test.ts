import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOllamaCudaUuidPin,
  buildRealOllamaSmokeEvidence,
  extractOllamaStructuringProvenance,
} from './real-ollama-smoke.ts';
import {
  buildFinalizeIngestionRequest,
  buildOpenIngestionRequest,
  buildStartCaptureRequest,
  isTerminalCaptureStatus,
  validateWorkerMirrorUrl,
} from './v2-capture-flow.ts';

test('CUDA UUID pin check uses only the last printed server config', () => {
  const uuid = 'GPU-12345678-1234-1234-1234-123456789abc';
  const pinned = `msg="server config" env="map[CUDA_VISIBLE_DEVICES:${uuid} OLLAMA_DEBUG:INFO]"`;
  assert.doesNotThrow(() => assertOllamaCudaUuidPin(pinned + '\nother output'));
  for (const value of ['', '0', '-1', 'GPU-invalid', `${uuid}extra`]) {
    assert.throws(() => assertOllamaCudaUuidPin(`${pinned}\nmsg="server config" env="map[CUDA_VISIBLE_DEVICES:${value}]"`));
  }
  assert.throws(() => assertOllamaCudaUuidPin('no config'));
  assert.throws(() => assertOllamaCudaUuidPin('msg="server config" env="map[OLLAMA_DEBUG:INFO]"'));
});

const validDigest = `sha256:${'a'.repeat(64)}`;
const validSourceSha256 = 'b'.repeat(64);

test('validateWorkerMirrorUrl accepts unset or valid numeric loopback URLs and rejects invalid ones', () => {
  assert.equal(validateWorkerMirrorUrl(undefined), undefined);
  assert.equal(validateWorkerMirrorUrl(''), undefined);
  assert.equal(validateWorkerMirrorUrl('   '), undefined);
  assert.equal(validateWorkerMirrorUrl('http://127.0.0.1:43123'), 'http://127.0.0.1:43123');
  assert.equal(validateWorkerMirrorUrl('  http://127.0.0.1:8080  '), 'http://127.0.0.1:8080');

  for (const invalid of [
    'http://localhost:43123',
    'https://127.0.0.1:43123',
    'http://127.0.0.1:43123/worker',
    'http://127.0.0.1:43123?x=1',
    'http://127.0.0.1:43123#frag',
    'http://user:pass@127.0.0.1:43123',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:',
    'http://127.0.0.1:abc',
  ]) {
    assert.throws(() => validateWorkerMirrorUrl(invalid), /CAPTURE_REAL_SMOKE_WORKER_MIRROR_URL/u);
  }
});

test('isTerminalCaptureStatus distinguishes every v2 terminal and non-terminal state', () => {
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    assert.equal(isTerminalCaptureStatus(terminal), true, `expected ${terminal} to be terminal`);
  }
  for (const nonTerminal of [
    'waiting_input',
    'extracting',
    'awaiting_structuring',
    'structuring',
  ]) {
    assert.equal(isTerminalCaptureStatus(nonTerminal), false, `expected ${nonTerminal} to be non-terminal`);
  }
});

test('v2 request builders produce the expected ingestion, finalize, and start payloads', () => {
  assert.deepEqual(
    buildOpenIngestionRequest({
      clientRequestId: 'req-1',
      fileName: 'sample.pdf',
      totalBytes: 1234,
      sourceSha256: validSourceSha256,
    }),
    {
      protocolVersion: '2',
      kind: 'pdf',
      mode: 'file',
      clientRequestId: 'req-1',
      fileName: 'sample.pdf',
      mediaType: 'application/pdf',
      totalBytes: 1234,
      sourceSha256: validSourceSha256,
    },
  );

  assert.deepEqual(
    buildFinalizeIngestionRequest({
      totalBytes: 1234,
      sha256: validSourceSha256,
    }),
    {
      protocolVersion: '2',
      totalBytes: 1234,
      sha256: validSourceSha256,
    },
  );

  assert.deepEqual(
    buildStartCaptureRequest({
      clientRequestId: 'req-2',
      ingestionId: 'ing-1',
    }),
    {
      protocolVersion: '2',
      clientRequestId: 'req-2',
      ingestionId: 'ing-1',
      structuringMode: 'runtime',
      targetLanguage: 'zh-TW',
      startPolicy: 'eager',
    },
  );
});

function ollamaPayload(provenance: Record<string, unknown>) {
  return {
    operation: { captureId: 'cap-1', status: 'completed' },
    raw: { schemaVersion: '2' },
    result: {
      schemaVersion: '2',
      structuringEngine: {
        engine: 'ollama',
        model: 'qwen3.5-0.8b-structure-v1',
        digest: validDigest,
        ...provenance,
      },
    },
  };
}

test('extractOllamaStructuringProvenance reads nested v2 provenance and rejects invalid payloads', () => {
  const validPayload = ollamaPayload({ device: 'cuda', deviceName: 'GPU example' });

  assert.deepEqual(extractOllamaStructuringProvenance(validPayload), {
    schemaVersion: '2',
    structuringEngine: {
      engine: 'ollama',
      model: 'qwen3.5-0.8b-structure-v1',
      digest: validDigest,
      device: 'cuda',
      deviceName: 'GPU example',
    },
  });

  const withoutStructuring = {
    result: { schemaVersion: '2' },
  };
  assert.throws(() => extractOllamaStructuringProvenance(withoutStructuring), /Ollama profile provenance/u);

  const topLevelOnly = {
    schemaVersion: '2',
    structuringEngine: {
      engine: 'ollama',
      model: 'qwen3.5-0.8b-structure-v1',
      digest: validDigest,
    },
  };
  assert.throws(() => extractOllamaStructuringProvenance(topLevelOnly), /Ollama profile provenance/u);

  const wrongEngine = {
    result: {
      schemaVersion: '2',
      structuringEngine: {
        engine: 'host',
        model: 'qwen3.5-0.8b-structure-v1',
        digest: validDigest,
      },
    },
  };
  assert.throws(() => extractOllamaStructuringProvenance(wrongEngine), /Ollama profile provenance/u);

  for (const badDigest of [
    'a'.repeat(64),
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'g'.repeat(64)}`,
  ]) {
    assert.throws(
      () =>
        extractOllamaStructuringProvenance({
          result: {
            schemaVersion: '2',
            structuringEngine: {
              engine: 'ollama',
              model: 'qwen3.5-0.8b-structure-v1',
              digest: badDigest,
            },
          },
        }),
      /Ollama profile provenance/u,
    );
  }
});

test('extractOllamaStructuringProvenance reads the device the owned Ollama ran on', () => {
  for (const { reported, device, deviceName } of [
    { reported: { device: 'cuda', deviceName: 'GPU example' }, device: 'cuda', deviceName: 'GPU example' },
    { reported: { device: 'rocm', deviceName: 'GPU example' }, device: 'rocm', deviceName: 'GPU example' },
    { reported: { device: 'vulkan', deviceName: 'GPU example' }, device: 'vulkan', deviceName: 'GPU example' },
    { reported: { device: 'cpu', deviceName: null }, device: 'cpu', deviceName: null },
    { reported: { device: 'cpu' }, device: 'cpu', deviceName: null },
    { reported: { device: null, deviceName: null }, device: null, deviceName: null },
    // An external Ollama or an unobserved device reports neither field.
    { reported: {}, device: null, deviceName: null },
  ]) {
    assert.deepEqual(
      extractOllamaStructuringProvenance(ollamaPayload(reported)).structuringEngine,
      {
        engine: 'ollama',
        model: 'qwen3.5-0.8b-structure-v1',
        digest: validDigest,
        device,
        deviceName,
      },
      JSON.stringify(reported),
    );
  }
});

test('extractOllamaStructuringProvenance rejects device provenance the runtime does not report', () => {
  for (const reported of [
    // Not a backend.
    { device: 'gpu' },
    { device: 'local' },
    { device: 'remote' },
    { device: 5 },
    // A name belongs to a GPU backend only.
    { device: 'cpu', deviceName: 'GPU example' },
    { device: null, deviceName: 'GPU example' },
    { deviceName: 'GPU example' },
    // A name is a non-empty string.
    { device: 'cuda', deviceName: '' },
    { device: 'cuda', deviceName: '   ' },
    { device: 'cuda', deviceName: 5 },
  ]) {
    assert.throws(
      () => extractOllamaStructuringProvenance(ollamaPayload(reported)),
      /invalid Ollama device provenance/u,
      JSON.stringify(reported),
    );
  }
});

test('buildRealOllamaSmokeEvidence builds the redacted evidence object with workerMirrorUsed', () => {
  const provenance = {
    engine: 'ollama' as const,
    model: 'qwen3.5-0.8b-structure-v1' as const,
    digest: validDigest,
    device: 'cuda',
    deviceName: 'GPU example',
  };

  assert.deepEqual(
    buildRealOllamaSmokeEvidence({
      schemaVersion: '2',
      structuringEngine: provenance,
      workerMirrorUsed: true,
    }),
    {
      evidenceKind: 'real-isolated-ollama-smoke',
      releaseGateSatisfied: false,
      sourceKind: 'pdf',
      schemaVersion: '2',
      structuringEngine: provenance,
      workerMirrorUsed: true,
    },
  );

  assert.equal(
    buildRealOllamaSmokeEvidence({
      schemaVersion: '2',
      structuringEngine: provenance,
      workerMirrorUsed: false,
    }).workerMirrorUsed,
    false,
  );
});
