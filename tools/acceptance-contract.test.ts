import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertWebmArtifact,
  createAcceptanceRun,
  redactAcceptanceText,
  readAcceptanceManifestTolerant,
  readOcrExecutionFailure,
  readOcrExecutionProof,
  sanitizeAcceptanceEvidence,
  sanitizeAcceptanceDiagnostic,
  sha256File,
  writeAcceptanceManifest,
} from './acceptance-contract.ts';
import { boundWorkerStageSequence } from './generated-worker-stage-policy.ts';

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

const failureRuntimeSha256 = 'b'.repeat(64);
const failureWorkerSha256 = 'c'.repeat(64);

function proofFixture(): Record<string, unknown> {
  const identity = {
    adapterClass: 'dedicated',
    adapterLuid: '00000000000000aa',
    vendorId: '10de',
    deviceId: '2204',
    subsystemId: '00000001',
    revision: '01',
    description: 'test GPU',
  };
  const identitySha256 = createHash('sha256')
    .update(canonicalJson(identity))
    .digest('hex');
  const proofWithoutDigest = {
    schemaVersion: '1',
    selectionProof: {
      identity: { ...identity, identitySha256 },
      highPerformanceRank: 0,
      dmlDeviceId: 0,
      adapterMapSha256: 'b'.repeat(64),
      planSha256: 'c'.repeat(64),
    },
    pipelineConstruction: {
      pre: {
        adapterLuid: '00000000000000aa',
        adapterMapSha256: 'b'.repeat(64),
        factoryCurrent: true,
      },
      post: {
        adapterLuid: '00000000000000aa',
        adapterMapSha256: 'b'.repeat(64),
        factoryCurrent: true,
      },
    },
    sessionDeviceProofs: [
      {
        sessionIndex: 0,
        providerOrder: ['DmlExecutionProvider', 'CPUExecutionProvider'],
        dmlDeviceId: 0,
        fallbackDisabled: true,
        dmlNodeCount: 2,
        cpuNodeCount: 1,
        evidenceSource: 'ort-graph-assignment',
      },
    ],
    sourceSha256: 'd'.repeat(64),
    requestedPageScope: [1],
    dmlNodeCount: 2,
    runtimeSha256: 'e'.repeat(64),
    workerSha256: 'f'.repeat(64),
    modelSha256: '1'.repeat(64),
    profileId: 'capture-workbench-ocr-pipeline-v1',
    profileSpecSha256: '2'.repeat(64),
    contractSetSha256: '3'.repeat(64),
  };
  return {
    ...proofWithoutDigest,
    executionSha256: createHash('sha256')
      .update(canonicalJson(proofWithoutDigest))
      .digest('hex'),
  };
}

function proofWithSessionMutation(
  mutate: (session: Record<string, unknown>) => void,
): Record<string, unknown> {
  const proof = proofFixture();
  const sessions = proof.sessionDeviceProofs as Array<Record<string, unknown>>;
  mutate(sessions[0]);
  const withoutDigest = { ...proof };
  delete withoutDigest.executionSha256;
  return {
    ...proof,
    executionSha256: createHash('sha256')
      .update(canonicalJson(withoutDigest))
      .digest('hex'),
  };
}

test('acceptance proof remains immutable and binds a bounded GPU summary to the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-proof-'));
  const proofPath = join(root, 'ocr-device-proof-v1.json');
  const proofBytes = Buffer.from(`${canonicalJson(proofFixture())}\n`);
  await writeFile(proofPath, proofBytes);

  const proof = await readOcrExecutionProof(root);
  assert.deepEqual(proof, {
    artifactPath: 'ocr-device-proof-v1.json',
    bytes: proofBytes.length,
    sha256: createHash('sha256').update(proofBytes).digest('hex'),
    schemaVersion: '1',
    planSha256: 'c'.repeat(64),
    identitySha256: proofFixture().selectionProof instanceof Object
      ? ((proofFixture().selectionProof as Record<string, unknown>).identity as Record<string, unknown>).identitySha256
      : undefined,
    dmlDeviceId: 0,
    dmlNodeCount: 2,
    sessionCount: 1,
    executionSha256: proofFixture().executionSha256,
    sourceSha256: 'd'.repeat(64),
    runtimeSha256: 'e'.repeat(64),
    workerSha256: 'f'.repeat(64),
    modelSha256: '1'.repeat(64),
    profileId: 'capture-workbench-ocr-pipeline-v1',
    profileSpecSha256: '2'.repeat(64),
    contractSetSha256: '3'.repeat(64),
    requestedPageScope: [1],
  });

  const screenshot = join(root, 'ready.png');
  await writeFile(screenshot, Buffer.from('png'));
  const manifestPath = await writeAcceptanceManifest(root, {
    project: 'capture-workbench',
    runId: 'run-1',
    status: 'completed',
    recordVideo: false,
    artifacts: [
      { path: proofPath, kind: 'log' },
      { path: screenshot, kind: 'screenshot' },
    ],
    cleanup: {
      app: false,
      sidecar: true,
      cdpPort: true,
      temporaryAppData: true,
      ownedPids: true,
      ownedListeners: true,
      ownedWorkers: true,
    },
    fixture: { name: 'source.pdf', sha256: proof.sourceSha256 },
    evidence: { ocrExecutionProof: proof },
  });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    artifacts: Array<{ path: string; bytes: number; sha256: string }>;
    evidence: { ocrExecutionProof: typeof proof };
  };
  const manifestProof = manifest.artifacts.find((artifact) => artifact.path === proof.artifactPath);
  assert.deepEqual(manifestProof, {
    path: proof.artifactPath,
    kind: 'log',
    bytes: proof.bytes,
    sha256: proof.sha256,
  });
  assert.deepEqual(manifest.evidence.ocrExecutionProof, proof);
  assert.deepEqual(await readFile(proofPath), proofBytes);
  const context = { project: 'capture-workbench', runId: 'run-1', recordVideo: false, artifactRoot: root, validateTerminalManifest: () => true, validateChildManifest: async () => true }, baseline = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, any>, artifact = (candidate: Record<string, any>) => candidate.artifacts.find((item: any) => item.path === proof.artifactPath);
  for (const mutate of [(candidate: any) => { candidate.artifacts = candidate.artifacts.filter((item: any) => item.path !== proof.artifactPath); }, (candidate: any) => { candidate.artifacts.push({ ...artifact(candidate), sha256: '0'.repeat(64) }); }, (candidate: any) => { artifact(candidate).bytes = proof.bytes + 1; }, (candidate: any) => { artifact(candidate).sha256 = '0'.repeat(64); }, (candidate: any) => { artifact(candidate).kind = 'other'; }, (candidate: any) => { candidate.fixture.sha256 = '0'.repeat(64); }]) { const candidate = JSON.parse(JSON.stringify(baseline)); mutate(candidate); await writeFile(manifestPath, `${JSON.stringify(candidate)}\n`); assert.equal((await readAcceptanceManifestTolerant(context)).status, 'missing-or-invalid'); } await writeFile(manifestPath, `${JSON.stringify(baseline)}\n`); assert.equal((await readAcceptanceManifestTolerant(context)).status, 'valid');
});

test('acceptance proof reader fails closed on a tampered digest or extra private field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-proof-invalid-'));
  const proofPath = join(root, 'ocr-device-proof-v1.json');
  const tampered = proofFixture();
  tampered.executionSha256 = '0'.repeat(64);
  await writeFile(proofPath, `${canonicalJson(tampered)}\n`);
  await assert.rejects(() => readOcrExecutionProof(root), /digest is invalid/u);

  const extraField = proofFixture();
  extraField.captureId = 'must-not-be-accepted';
  await writeFile(proofPath, `${canonicalJson(extraField)}\n`);
  await assert.rejects(() => readOcrExecutionProof(root), /unsupported fields/u);
});

test('acceptance proof reader fails closed on malformed identity fields and page scope', async () => {
  const cases: Array<[string, RegExp]> = [
    ['modelSha256', /OCR model digest/u],
    ['profileId', /OCR profile identity/u],
    ['requestedPageScope', /OCR requested page scope/u],
  ];
  for (const [field, message] of cases) {
    const root = await mkdtemp(join(tmpdir(), `acceptance-proof-shape-${field}-`));
    const proofPath = join(root, 'ocr-device-proof-v1.json');
    const proof = proofFixture();
    if (field === 'modelSha256') proof.modelSha256 = 'not-a-sha';
    if (field === 'profileId') proof.profileId = 'C:\\private\\profile';
    if (field === 'requestedPageScope') proof.requestedPageScope = [2];
    await writeFile(proofPath, `${canonicalJson(proof)}\n`);
    await assert.rejects(() => readOcrExecutionProof(root), message, field);
  }
});

test('acceptance proof reader accepts an ORT session with an unobservable DML device id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-proof-null-device-'));
  const proofPath = join(root, 'ocr-device-proof-v1.json');
  await writeFile(proofPath, `${canonicalJson(proofWithSessionMutation((session) => {
    session.dmlDeviceId = null;
  }))}\n`);

  await assert.doesNotReject(() => readOcrExecutionProof(root));
});

test('acceptance proof reader accepts an explicitly matched DML device id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-proof-matched-device-'));
  const proofPath = join(root, 'ocr-device-proof-v1.json');
  await writeFile(proofPath, `${canonicalJson(proofWithSessionMutation((session) => {
    session.dmlDeviceId = 0;
  }))}\n`);

  await assert.doesNotReject(() => readOcrExecutionProof(root));
});

test('acceptance proof reader keeps non-device GPU invariants strict when DML device id is null', async () => {
  const cases: Array<{
    name: string;
    mutate: (session: Record<string, unknown>) => void;
    message: RegExp;
  }> = [
    {
      name: 'mismatched non-null device id',
      mutate: (session) => { session.dmlDeviceId = 1; },
      message: /session device or fallback evidence drifted/u,
    },
    {
      name: 'invalid non-null device id',
      mutate: (session) => { session.dmlDeviceId = '0'; },
      message: /session device or fallback evidence drifted/u,
    },
    {
      name: 'zero DML nodes',
      mutate: (session) => {
        session.dmlDeviceId = null;
        session.dmlNodeCount = 0;
      },
      message: /DML node count must be positive/u,
    },
    {
      name: 'fallback enabled',
      mutate: (session) => {
        session.dmlDeviceId = null;
        session.fallbackDisabled = false;
      },
      message: /session device or fallback evidence drifted/u,
    },
    {
      name: 'provider order changed',
      mutate: (session) => {
        session.dmlDeviceId = null;
        session.providerOrder = ['CPUExecutionProvider', 'DmlExecutionProvider'];
      },
      message: /session provider order is invalid/u,
    },
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `acceptance-proof-null-device-${item.name.replaceAll(' ', '-')}-`));
    const proofPath = join(root, 'ocr-device-proof-v1.json');
    await writeFile(proofPath, `${canonicalJson(proofWithSessionMutation(item.mutate))}\n`);
    await assert.rejects(() => readOcrExecutionProof(root), item.message, item.name);
  }
});

test('acceptance run defaults to the isolated project output root', () => {
  const run = createAcceptanceRun(
    {
      E2E_ACCEPTANCE_RUN_ID: 'run-2026-08-17',
      E2E_RECORD_VIDEO: '0',
    },
    'capture-workbench',
    'C:\\software-dev\\capture-workbench',
  );

  assert.equal(run.runId, 'run-2026-08-17');
  assert.equal(run.recordVideo, false);
  assert.match(run.artifactRoot, /output[\\/]playwright[\\/]capture-workbench[\\/]run-2026-08-17$/u);
});

test('recorded acceptance requires an explicit valid run id', () => {
  assert.throws(
    () => createAcceptanceRun({ E2E_RECORD_VIDEO: '1' }, 'capture-workbench', process.cwd()),
    /E2E_ACCEPTANCE_RUN_ID/u,
  );
  assert.throws(
    () => createAcceptanceRun({ E2E_ACCEPTANCE_RUN_ID: '../escape' }, 'capture-workbench', process.cwd()),
    /run ID/u,
  );
});

test('WebM validation and SHA-256 are fail-closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-contract-'));
  const video = join(root, 'journey.webm');
  await writeFile(video, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]));

  assert.equal(await assertWebmArtifact(video), true);
  assert.match(await sha256File(video), /^[a-f0-9]{64}$/u);

  const invalid = join(root, 'invalid.webm');
  await writeFile(invalid, Buffer.from('not a video'));
  await assert.rejects(() => assertWebmArtifact(invalid), /EBML\/WebM/u);
});

test('manifest writing redacts secrets and absolute paths from text artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-manifest-'));
  const screenshot = join(root, 'ready.png');
  await writeFile(screenshot, Buffer.from('png'));
  const log = join(root, 'console-errors.json');
  await writeFile(log, JSON.stringify({
    message: 'Authorization: Bearer secret-token with "quoted" text',
    token: 'raw-secret',
    path: 'C:\\Users\\Private\\fixture.pdf',
    nested: {
      authorization: 'Bearer nested-secret with "escaped" quotes',
      client_secret: 'raw-client-secret',
    },
  }));

  const manifestPath = await writeAcceptanceManifest(root, {
    project: 'capture-workbench',
    runId: 'run-1',
    status: 'completed',
    recordVideo: false,
    artifacts: [
      { path: screenshot, kind: 'screenshot' },
      { path: log, kind: 'log' },
    ],
    errors: ['Authorization: Bearer secret-token C:\\Users\\Private\\fixture.pdf'],
    cleanup: {
      app: true,
      sidecar: true,
      cdpPort: true,
      temporaryAppData: true,
      ownedPids: true,
      ownedListeners: true,
      ownedWorkers: true,
    },
  });

  const contents = await import('node:fs/promises').then(({ readFile: read }) => read(manifestPath, 'utf8'));
  assert.doesNotMatch(contents, /secret-token|C:\\Users\\Private/u);
  const redactedLog = await import('node:fs/promises').then(({ readFile: read }) => read(log, 'utf8'));
  assert.doesNotMatch(
    redactedLog,
    /secret-token|raw-secret|raw-client-secret|nested-secret|C:\\Users\\Private/u,
  );
  assert.doesNotThrow(() => JSON.parse(redactedLog));
  assert.match(contents, /"status": "completed"/u);
});

test('manifest evidence keeps only hashes, counts, CER, provenance, and cleanup-safe codes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-evidence-'));
  const screenshot = join(root, 'checkpoint.png');
  await writeFile(screenshot, Buffer.from('png'));
  const manifestPath = await writeAcceptanceManifest(root, {
    project: 'capture-workbench',
    runId: 'run-1',
    status: 'failed',
    recordVideo: false,
    artifacts: [{ path: screenshot, kind: 'screenshot' }],
    errors: ['OCR truth leaked PRIVATE_OCR C:\\Users\\Private\\fixture.pdf Bearer secret'],
    cleanup: {
      app: false,
      sidecar: false,
      cdpPort: true,
      temporaryAppData: true,
      ownedPids: false,
      ownedListeners: true,
      ownedWorkers: false,
    },
    fixture: { name: 'C:\\Users\\Private\\source.pdf', sha256: 'a'.repeat(64) },
    evidence: {
      sourceSha256: 'b'.repeat(64),
      importedSourceSha256: 'b'.repeat(64),
      runtimeArtifactSha256: 'c'.repeat(64),
      contractSetSha256: 'd'.repeat(64),
      workerArchiveSha256: 'e'.repeat(64),
      workerExecutableSha256: 'f'.repeat(64),
      candidateId: '1'.repeat(64),
      catalogSha256: '2'.repeat(64),
      modelManifestSha256: '3'.repeat(64),
      sourceLockSha256: '4'.repeat(64),
      modelFileCount: 10,
      modelExtractedBytes: 138863396,
      authenticatedRuntimePreflight: 'gpu-dml',
      uiGpuBeforeImport: true,
      cer: 0.0123,
      expectedAnchorCount: 4,
      matchedAnchorCount: 4,
      pdfPageScope: {
        sourcePageCount: 46,
        requestedPageNumbers: [1],
        processedPageNumbers: [1],
      },
      provenance: {
        ocrEngine: 'windowsml-ocr',
        ocrModel: 'pp-ocrv6-medium-windowsml',
        ocrDevice: 'windowsml-dml',
        structuringEngine: 'ollama',
        structuringModel: 'capture-workbench-qwen3.5-4b-structure-v1',
      },
    },
  });
  const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile: read }) => read(manifestPath, 'utf8'))) as Record<string, unknown>;
  assert.deepEqual(manifest.evidence, {
    sourceSha256: 'b'.repeat(64),
    importedSourceSha256: 'b'.repeat(64),
    runtimeArtifactSha256: 'c'.repeat(64),
    contractSetSha256: 'd'.repeat(64),
    workerArchiveSha256: 'e'.repeat(64),
    workerExecutableSha256: 'f'.repeat(64),
    candidateId: '1'.repeat(64),
    catalogSha256: '2'.repeat(64),
    modelManifestSha256: '3'.repeat(64),
    sourceLockSha256: '4'.repeat(64),
    modelFileCount: 10,
    modelExtractedBytes: 138863396,
    authenticatedRuntimePreflight: 'gpu-dml',
    uiGpuBeforeImport: true,
    cer: 0.0123,
    expectedAnchorCount: 4,
    matchedAnchorCount: 4,
    pdfPageScope: {
      sourcePageCount: 46,
      requestedPageNumbers: [1],
      processedPageNumbers: [1],
    },
    provenance: {
      ocrEngine: 'windowsml-ocr',
      ocrModel: 'pp-ocrv6-medium-windowsml',
      ocrDevice: 'windowsml-dml',
      structuringEngine: 'ollama',
      structuringModel: 'capture-workbench-qwen3.5-4b-structure-v1',
    },
  });
  assert.deepEqual(manifest.fixture, { name: 'fixture.pdf', sha256: 'a'.repeat(64) });
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /PRIVATE_OCR|C:\\Users\\Private|Bearer secret/u);
  assert.equal(sanitizeAcceptanceDiagnostic('OCR expected truth: PRIVATE_OCR at C:\\Users\\Private\\x.pdf'), 'ocr_verification_failed');
  assert.equal(
    sanitizeAcceptanceDiagnostic(
      'Standalone desktop OCR terminated. status=failed; errorCode=ocr_worker_failed.',
    ),
    'ocr_worker_failed',
  );
  assert.equal(
    sanitizeAcceptanceDiagnostic(
      'expect(page).toHaveScreenshot(01-runtime-ready.png) failed: 21766 pixels (ratio 0.02) differ in real-desktop-ocr-acceptance.spec.ts',
    ),
    'browser_acceptance_failed',
  );
});

test('manifest preserves typed phase flags while rejecting malformed or private evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-phase-flags-'));
  const screenshot = join(root, 'checkpoint.png');
  await writeFile(screenshot, Buffer.from('png'));
  const phaseEvidence = {
    acceptanceMode: 'ocr-only',
    ocrProofSucceeded: true,
    structuringSucceeded: false,
    releaseGateSatisfied: false,
    sourceSha256: 'a'.repeat(64),
    diagnostics: 'Authorization: Bearer secret-token',
    text: 'OCR text must not enter the manifest',
    path: 'C:\\Users\\Private\\fixture.pdf',
    token: 'raw-secret',
  };

  assert.deepEqual(sanitizeAcceptanceEvidence(phaseEvidence), {
    acceptanceMode: 'ocr-only',
    ocrProofSucceeded: true,
    structuringSucceeded: false,
    releaseGateSatisfied: false,
    sourceSha256: 'a'.repeat(64),
  });

  const manifestPath = await writeAcceptanceManifest(root, {
    project: 'capture-workbench',
    runId: 'run-1',
    status: 'failed',
    recordVideo: false,
    artifacts: [{ path: screenshot, kind: 'screenshot' }],
    cleanup: {
      app: true,
      sidecar: true,
      cdpPort: true,
      temporaryAppData: true,
      ownedPids: true,
      ownedListeners: true,
      ownedWorkers: true,
    },
    evidence: phaseEvidence,
  });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(manifest.evidence, {
    acceptanceMode: 'ocr-only',
    ocrProofSucceeded: true,
    structuringSucceeded: false,
    releaseGateSatisfied: false,
    sourceSha256: 'a'.repeat(64),
  });
  assert.doesNotMatch(JSON.stringify(manifest), /secret-token|OCR text|C:\\Users\\Private|raw-secret/u);

  const malformed = sanitizeAcceptanceEvidence({
    acceptanceMode: 'unknown-mode',
    ocrProofSucceeded: 'true',
    structuringSucceeded: null,
    releaseGateSatisfied: 0,
    sourceSha256: 'b'.repeat(64),
  });
  assert.deepEqual(malformed, { sourceSha256: 'b'.repeat(64) });
});

test('manifest drops an invalid fixture digest instead of persisting token material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-invalid-fixture-'));
  const screenshot = join(root, 'checkpoint.png');
  await writeFile(screenshot, Buffer.from('png'));
  const manifestPath = await writeAcceptanceManifest(root, {
    project: 'capture-workbench',
    runId: 'run-1',
    status: 'failed',
    recordVideo: false,
    artifacts: [{ path: screenshot, kind: 'screenshot' }],
    fixture: {
      name: 'C:\\Users\\Private\\source.pdf',
      sha256: 'Bearer secret-token',
    },
    cleanup: {
      app: false,
      sidecar: false,
      cdpPort: false,
      temporaryAppData: false,
      ownedPids: false,
      ownedListeners: false,
      ownedWorkers: false,
    },
  });
  const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile: read }) => read(manifestPath, 'utf8'))) as Record<string, unknown>;
  assert.equal(manifest.fixture, undefined);
  assert.doesNotMatch(JSON.stringify(manifest), /C:\\Users\\Private|Bearer secret-token/u);
});

test('redaction is stable for bearer tokens and local paths', () => {
  const redacted = redactAcceptanceText(
    'Bearer abc.def.ghi at C:\\Users\\Alice\\fixture.pdf and /private/data/file.pdf',
  );
  assert.equal(redacted.includes('abc.def.ghi'), false);
  assert.equal(redacted.includes('C:\\Users\\Alice'), false);
  assert.equal(redacted.includes('/private/data'), false);
});

test('OCR failure evidence is strictly validated and bound to the supplied source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-ocr-failure-'));
  const sourceSha256 = 'a'.repeat(64);
  const failurePath = join(root, 'ocr-execution-failure-v1.json');
  await writeFile(
    failurePath,
    JSON.stringify({
      schemaVersion: '1',
      sourceSha256,
      sourceRole: 'image',
      stageSequence: [
        'ocr-pipeline-create-start',
        'ocr-pipeline-create-failed-runtimeerror',
        'python-import-paddleocr-failed-importerror-native-load-paddleocr', 'python-import-paddleocr-failed-importerror-native-load-paddleocr-dependency-missing-opencv',
      ],
      failureClass: 'exit-nonzero',
      exitCode: 7,
      runtimeSha256: failureRuntimeSha256,
      workerSha256: failureWorkerSha256,
    }),
    'utf8',
  );

  const exactFailureExpectation = {
    sourceRole: 'image' as const,
    sourceSha256,
    runtimeSha256: failureRuntimeSha256,
    workerSha256: failureWorkerSha256,
  };
  const summary = await readOcrExecutionFailure(root, exactFailureExpectation);
  assert.equal(summary.artifactPath, 'ocr-execution-failure-v1.json');
  assert.equal(summary.sourceSha256, sourceSha256);
  assert.equal(summary.runtimeSha256, failureRuntimeSha256);
  assert.equal(summary.workerSha256, failureWorkerSha256);
  assert.equal(summary.failureClass, 'exit-nonzero');
  assert.deepEqual(summary.stageSequence, [
    'ocr-pipeline-create-start',
    'ocr-pipeline-create-failed-runtimeerror',
    'python-import-paddleocr-failed-importerror-native-load-paddleocr', 'python-import-paddleocr-failed-importerror-native-load-paddleocr-dependency-missing-opencv',
  ]);
  await assert.rejects(
    () => Reflect.apply(readOcrExecutionFailure, undefined, [root]),
    /expected OCR failure identity is required/u,
  );
  await assert.rejects(
    () => Reflect.apply(readOcrExecutionFailure, undefined, [root, sourceSha256]),
    /expected OCR failure identity is required/u,
  );
  await assert.rejects(
    () => readOcrExecutionFailure(root, { ...exactFailureExpectation, sourceRole: 'pdf' }),
    /sourceRole does not match the authenticated identity/u,
  );
  await assert.rejects(
    () => readOcrExecutionFailure(root, { ...exactFailureExpectation, workerSha256: 'd'.repeat(64) }),
    /workerSha256 does not match the authenticated identity/u,
  );
  await assert.rejects(
    () => readOcrExecutionFailure(root, {
      sourceRole: 'image',
      sourceSha256,
      runtimeSha256: 'd'.repeat(64),
      workerSha256: failureWorkerSha256,
    }),
    /runtimeSha256 does not match the authenticated identity/u,
  );

  await writeFile(
    failurePath,
    JSON.stringify({
      schemaVersion: '1',
      sourceSha256,
      sourceRole: 'image',
      stageSequence: Array.from({ length: 33 }, () => 'ocr-predict-start'),
      failureClass: 'exit-nonzero',
      runtimeSha256: failureRuntimeSha256,
      workerSha256: failureWorkerSha256,
    }),
    'utf8',
  );
  await assert.rejects(
    () => readOcrExecutionFailure(root, exactFailureExpectation),
    /stage sequence is invalid/u,
  );

  await writeFile(
    failurePath,
    JSON.stringify({
      schemaVersion: '1',
      sourceSha256,
      sourceRole: 'image',
      stageSequence: ['ocr-predict-start'],
      failureClass: 'exit-nonzero',
      unexpected: 'must fail closed',
      runtimeSha256: failureRuntimeSha256,
      workerSha256: failureWorkerSha256,
    }),
    'utf8',
  );
  await assert.rejects(
    () => readOcrExecutionFailure(root, exactFailureExpectation),
    /fields are invalid/u,
  );

  await writeFile(
    failurePath,
    JSON.stringify({
      schemaVersion: '1',
      sourceSha256,
      sourceRole: 'image',
      stageSequence: ['capture-worker-stage:secret-token-abc123'],
      failureClass: 'exit-nonzero',
      runtimeSha256: failureRuntimeSha256,
      workerSha256: failureWorkerSha256,
    }),
    'utf8',
  );
  await assert.rejects(
    () => readOcrExecutionFailure(root, exactFailureExpectation),
    /private diagnostics/u,
  );

  await writeFile(
    failurePath,
    JSON.stringify({
      schemaVersion: '1',
      sourceSha256: 'e'.repeat(64),
      sourceRole: 'image',
      stageSequence: ['ocr-predict-start'],
      failureClass: 'exit-nonzero',
      runtimeSha256: failureRuntimeSha256,
      workerSha256: failureWorkerSha256,
    }),
    'utf8',
  );
  await assert.rejects(
    () => readOcrExecutionFailure(root, exactFailureExpectation),
    /does not match the supplied source/u,
  );
});

test('canonical worker stage bounding preserves GPU semantics across the TS reader', () => {
  const criticalStages = [
    'ocr-native-map-before',
    'ocr-paddle-factory',
    'ocr-native-map-after',
    'ocr-execution-evidence-prepare',
    'ocr-dml-device-id-unobservable',
  ];
  const stages = [
    'worker-entry-start',
    'python-import-pdfium-start',
    'python-import-pdfium-complete',
    'python-import-pillow-start',
    'python-import-pillow-complete',
    'python-import-capture-runtime-start',
    'python-import-capture-runtime-complete',
    'python-import-onnxruntime-start',
    'python-import-onnxruntime-complete',
    'python-import-paddleocr-start',
    'python-import-paddleocr-complete',
    'ocr-pdf-render-start',
    'ocr-pdf-render-complete',
    'ocr-probe-start',
    'ocr-probe-modules-start',
    'ocr-probe-modules-ready',
    ...criticalStages,
    ...Array.from({ length: 40 }, () => 'ocr-probe-complete'),
    'ocr-predict-failed-runtimeerror',
  ];
  const bounded = boundWorkerStageSequence(stages);

  assert.equal(stages.length > 32, true);
  assert.equal(bounded.length, 32);
  assert.equal(bounded.includes('worker-stage-sequence-truncated'), true);
  assert.equal(bounded.at(-1), 'ocr-predict-failed-runtimeerror');
  for (const stage of criticalStages) assert.equal(bounded.includes(stage), true);
});

test('manifest preserves and binds the validated OCR failure artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-ocr-failure-manifest-'));
  const sourceSha256 = 'd'.repeat(64);
  const exactFailureExpectation = {
    sourceRole: 'image' as const,
    sourceSha256,
    runtimeSha256: failureRuntimeSha256,
    workerSha256: failureWorkerSha256,
  };
  const failurePath = join(root, 'ocr-execution-failure-v1.json');
  await writeFile(
    failurePath,
    JSON.stringify({
      schemaVersion: '1',
      sourceSha256,
      sourceRole: 'image',
      stageSequence: ['ocr-predict-start'],
      failureClass: 'no-response',
      exitCode: 7,
      runtimeSha256: failureRuntimeSha256,
      workerSha256: failureWorkerSha256,
    }),
    'utf8',
  );
  const summary = await readOcrExecutionFailure(root, exactFailureExpectation);
  const manifestPath = await writeAcceptanceManifest(root, {
    project: 'capture-workbench',
    runId: 'run-ocr-failure',
    status: 'failed',
    recordVideo: false,
    artifacts: [{ path: failurePath, kind: 'log' }],
    fixture: { name: 'source.jpg', sha256: sourceSha256 },
    verifiedOcrExecutionFailure: summary,
    evidence: { sourceSha256, ocrExecutionFailure: summary },
    cleanup: {
      app: true,
      sidecar: true,
      cdpPort: true,
      temporaryAppData: true,
      ownedPids: true,
      ownedListeners: true,
      ownedWorkers: true,
    },
  });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, any>;
  const metadata = await stat(failurePath);
  assert.deepEqual(manifest.artifacts, [{
    path: 'ocr-execution-failure-v1.json',
    kind: 'log',
    bytes: metadata.size,
    sha256: await sha256File(failurePath),
  }]);
  assert.deepEqual(manifest.evidence.ocrExecutionFailure, summary);
  assert.equal(await readFile(failurePath, 'utf8'), JSON.stringify({
    schemaVersion: '1',
    sourceSha256,
    sourceRole: 'image',
    stageSequence: ['ocr-predict-start'],
    failureClass: 'no-response',
    exitCode: 7,
    runtimeSha256: failureRuntimeSha256,
    workerSha256: failureWorkerSha256,
  }));
});
