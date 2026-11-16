import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
    'created',
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

test('extractOllamaStructuringProvenance reads nested v2 provenance and rejects invalid payloads', () => {
  const validPayload = {
    operation: { captureId: 'cap-1', status: 'completed' },
    raw: { schemaVersion: '2' },
    result: {
      schemaVersion: '2',
      structuringEngine: {
        engine: 'ollama',
        model: 'capture-workbench-qwen3.5-0.8b-structure-v1',
        digest: validDigest,
        device: 'gpu',
      },
    },
  };

  assert.deepEqual(extractOllamaStructuringProvenance(validPayload), {
    schemaVersion: '2',
    structuringEngine: {
      engine: 'ollama',
      model: 'capture-workbench-qwen3.5-0.8b-structure-v1',
      digest: validDigest,
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
      model: 'capture-workbench-qwen3.5-0.8b-structure-v1',
      digest: validDigest,
    },
  };
  assert.throws(() => extractOllamaStructuringProvenance(topLevelOnly), /Ollama profile provenance/u);

  const wrongEngine = {
    result: {
      schemaVersion: '2',
      structuringEngine: {
        engine: 'host',
        model: 'capture-workbench-qwen3.5-0.8b-structure-v1',
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
              model: 'capture-workbench-qwen3.5-0.8b-structure-v1',
              digest: badDigest,
            },
          },
        }),
      /Ollama profile provenance/u,
    );
  }
});

test('buildRealOllamaSmokeEvidence builds the redacted evidence object with workerMirrorUsed', () => {
  const provenance = {
    engine: 'ollama' as const,
    model: 'capture-workbench-qwen3.5-0.8b-structure-v1' as const,
    digest: validDigest,
  };

  assert.deepEqual(
    buildRealOllamaSmokeEvidence({
      schemaVersion: '2',
      structuringEngine: provenance,
      workerMirrorUsed: true,
    }),
    {
      evidenceKind: 'real-isolated-ollama-smoke',
      releaseGateSatisfied: true,
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
