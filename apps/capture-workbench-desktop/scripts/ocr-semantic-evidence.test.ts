import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildOcrOnlySemanticEvidence,
  buildOcrSemanticEvidence,
  countAnchors,
  OcrSemanticEvidenceValidationError,
  OCR_SEMANTIC_EVIDENCE_ARTIFACT,
  writeOcrSemanticEvidenceArtifact,
} from './ocr-semantic-evidence.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- this test verifies the existing manifest identity surface.
import { writeAcceptanceManifest } from '../../../tools/acceptance-contract.ts';

const SOURCE_SHA = 'a'.repeat(64);
const RUNTIME_SHA = 'b'.repeat(64);
const CONTRACT_SHA = 'c'.repeat(64);
const WORKER_SHA = 'f'.repeat(64);

test('projects the durable library detail into privacy-safe JPEG semantic evidence', () => {
  const output = buildOcrSemanticEvidence(completedDetail(), expectedIdentity(),);

  assert.deepEqual(output, {
    schemaVersion: 1,
    artifactPath: OCR_SEMANTIC_EVIDENCE_ARTIFACT,
    runId: 'run-2026-08-29',
    fixtureName: 'ocr_test_image.jpeg',
    sourceKind: 'image',
    sourceSha256: SOURCE_SHA,
    captureId: 'capture-1',
    status: 'completed',
    ocrDevice: 'windowsml-dml',
    pageCount: 1,
    pages: [{
      page: 1,
      status: 'recognized',
      normalizedCharCount: 11,
      boxCount: 1,
      confidence: 0.875,
      confidenceSummary: {
        scoreState: 'numeric',
        numericCount: 1,
        min: 0.875,
        max: 0.875,
        mean: 0.875,
      },
    }],
    provenance: {
      runtimeVersion: '0.4.2',
      contractSha256: CONTRACT_SHA,
      engine: 'windowsml-ocr',
      model: 'ppocrv6-traditional-multilingual',
      modelDigest: `sha256:${'d'.repeat(64)}`,
      device: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
      workerSha256: WORKER_SHA,
    },
    rawNonEmpty: true,
    rawSegmentCount: 1,
    rawNonEmptySegmentCount: 1,
    resultNonEmpty: true,
    resultBlockCount: 1,
    resultNonEmptyBlockCount: 1,
    criticalAnchors: { expectedCount: 1, matchedCount: 1 },
    evidenceDigest: expectSha256OfDurableEvidence(),
  });

  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /snow man|box-secret|polygon|C:\\private|Bearer|token/u);
});

test('uses durable raw text for anchors and never substitutes summary counts', () => {
  const detail = completedDetail();
  assert.ok(detail.raw);
  detail.raw.sourceText = 'unrelated text';
  assert.throws(
    () => buildOcrSemanticEvidence(detail, expectedIdentity()),
    /critical OCR anchor/u,
  );
});

test('projects the durable awaiting OCR checkpoint without inventing a structured result', () => {
  const output = buildOcrOnlySemanticEvidence(ocrOnlyDetail(), expectedIdentity());

  assert.deepEqual(output, {
    schemaVersion: 1,
    artifactPath: OCR_SEMANTIC_EVIDENCE_ARTIFACT,
    runId: 'run-2026-08-29',
    fixtureName: 'ocr_test_image.jpeg',
    sourceKind: 'image',
    sourceSha256: SOURCE_SHA,
    captureId: 'capture-1',
    status: 'completed',
    ocrDevice: 'windowsml-dml',
    pageCount: 1,
    pages: [{
      page: 1,
      status: 'recognized',
      normalizedCharCount: 11,
      boxCount: 1,
      confidence: 0.875,
      confidenceSummary: {
        scoreState: 'numeric',
        numericCount: 1,
        min: 0.875,
        max: 0.875,
        mean: 0.875,
      },
    }],
    provenance: {
      runtimeVersion: '0.4.2',
      contractSha256: CONTRACT_SHA,
      engine: 'windowsml-ocr',
      model: 'ppocrv6-traditional-multilingual',
      modelDigest: `sha256:${'d'.repeat(64)}`,
      device: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
      workerSha256: WORKER_SHA,
    },
    rawNonEmpty: true,
    rawSegmentCount: 1,
    rawNonEmptySegmentCount: 1,
    resultNonEmpty: false,
    resultBlockCount: 0,
    resultNonEmptyBlockCount: 0,
    criticalAnchors: { expectedCount: 1, matchedCount: 1 },
    evidenceDigest: expectSha256OfDurableEvidence(),
  });
});

test('OCR-only semantic evidence fails closed for durable and execution-proof drift', () => {
  const base = ocrOnlyDetail();
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['digest mismatch', () => buildOcrOnlySemanticEvidence({ ...base, ocrEvidence: { ...base.ocrEvidence, digest: '0'.repeat(64) } }, expectedIdentity()), /digest mismatch/u],
    ['model mismatch', () => buildOcrOnlySemanticEvidence(base, { ...expectedIdentity(), ocrModel: 'wrong-model' }), /durable model mismatch/u],
    ['profile mismatch', () => buildOcrOnlySemanticEvidence(base, { ...expectedIdentity(), executionProof: { ...expectedIdentity().executionProof, profileId: 'wrong-profile' } }), /profileId does not match execution proof/u],
    ['worker mismatch', () => buildOcrOnlySemanticEvidence(base, { ...expectedIdentity(), workerSha256: '0'.repeat(64) }), /expected OCR proof workerSha256 mismatch/u],
    ['contract mismatch', () => buildOcrOnlySemanticEvidence(base, { ...expectedIdentity(), contractSha256: '0'.repeat(64) }), /expected OCR proof contractSetSha256 mismatch/u],
    ['device mismatch', () => buildOcrOnlySemanticEvidence(base, { ...expectedIdentity(), ocrDevice: 'cpu' }), /expected OCR proof device mismatch/u],
    ['proof mismatch', () => buildOcrOnlySemanticEvidence(base, { ...expectedIdentity(), executionProof: { ...expectedIdentity().executionProof, modelSha256: '0'.repeat(64) } }), /modelDigest does not match execution proof/u],
    ['anchor miss', () => buildOcrOnlySemanticEvidence(base, { ...expectedIdentity(), anchors: ['missing anchor'] }), /critical OCR anchor/u],
  ];
  for (const [name, action, message] of cases) assert.throws(action, message, name);
});

test('OCR-only semantic evidence rejects a structured result at the awaiting checkpoint', () => {
  assert.throws(
    () => buildOcrOnlySemanticEvidence({ ...ocrOnlyDetail(), result: completedDetail().result }, expectedIdentity()),
    /must not persist a structured result/u,
  );
});

test('reports the actual ordered partial anchor count while still failing incomplete evidence', () => {
  assert.deepEqual(
    countAnchors('Snow man raw OCR', ['snow man', 'second anchor']),
    { expectedCount: 2, matchedCount: 1 },
  );
});

test('fails closed when durable evidence or identity is missing or tampered', () => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['missing evidence', () => buildOcrSemanticEvidence({ ...completedDetail(), ocrEvidence: undefined }, expectedIdentity()), /durable OCR evidence/u],
    ['source mismatch', () => buildOcrSemanticEvidence(completedDetail(), { ...expectedIdentity(), sourceSha256: 'b'.repeat(64) }), /sourceSha256 mismatch/u],
    ['contract mismatch', () => buildOcrSemanticEvidence(completedDetail(), { ...expectedIdentity(), contractSha256: 'b'.repeat(64) }), /contract(?:Set)?Sha256 mismatch/u],
    ['worker mismatch', () => buildOcrSemanticEvidence(completedDetail(), { ...expectedIdentity(), workerSha256: 'b'.repeat(64) }), /workerSha256 mismatch/u],
    ['capture mismatch', () => buildOcrSemanticEvidence(completedDetail(), { ...expectedIdentity(), captureId: 'different-capture' }), /captureId mismatch/u],
    ['digest mismatch', () => buildOcrSemanticEvidence({ ...completedDetail(), ocrEvidence: { ...completedDetail().ocrEvidence, digest: '0'.repeat(64) } }, expectedIdentity()), /digest mismatch/u],
    ['anchor miss', () => buildOcrSemanticEvidence(completedDetail(), { ...expectedIdentity(), anchors: ['missing anchor'] }), /critical OCR anchor/u],
  ];
  for (const [name, action, message] of cases) assert.throws(action, message, name);
});

test('binds completed durable model and profile provenance to the execution proof', () => {
  const detail = completedDetail();
  const evidence = detail.ocrEvidence;
  const provenance = evidence.provenance as Record<string, unknown>;
  provenance.modelDigest = `sha256:${'1'.repeat(64)}`;
  provenance.profileId = 'wrong-profile';
  evidence.digest = sha256(canonicalJson(withoutKey(evidence, 'digest')));

  assert.throws(
    () => buildOcrSemanticEvidence(detail, expectedIdentity()),
    /modelDigest does not match execution proof/u,
  );
});

test('requires real JPEG semantics instead of a green result with empty OCR metrics', () => {
  const detail = completedDetail();
  const evidence = detail.ocrEvidence as {
    pages: Array<Record<string, unknown>>;
    summary: Record<string, unknown>;
    digest: string;
  };
  evidence.pages[0] = {
    ...evidence.pages[0],
    normalizedCharCount: 0,
    boxCount: 0,
    confidence: 0,
    confidenceSummary: {
      scoreState: 'none',
      numericCount: 0,
      min: null,
      max: null,
      mean: null,
    },
  };
  evidence.summary = {
    ...evidence.summary,
    normalizedCharCount: 0,
    boxCount: 0,
    confidenceSummary: evidence.pages[0].confidenceSummary,
  };
  evidence.digest = sha256(canonicalJson(withoutKey(evidence, 'digest')));
  assert.throws(
    () => buildOcrSemanticEvidence(detail, expectedIdentity()),
    /recognized page|characters, boxes, and numeric confidence/u,
  );
});

test('accepts a failed multi-page PDF evidence record without inventing OCR success', () => {
  const failed = failedPdfDetail();
  const output = buildOcrSemanticEvidence(failed, {
    ...expectedIdentity(false),
    fixtureName: 'legal-scan.pdf',
    sourceKind: 'pdf',
    anchors: [],
  });

  assert.deepEqual(output.pages.map((page) => [page.page, page.status]), [[1, 'empty'], [2, 'failed']]);
  assert.equal(output.status, 'failed');
  assert.deepEqual(output.criticalAnchors, { expectedCount: 0, matchedCount: 0 });
  assert.deepEqual(output.failure, {
    code: 'ocr_worker_failed',
    message: 'OCR failure: ocr_worker_failed.',
  });
});

test('writes semantic evidence atomically and returns manifest-ready bytes and SHA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocr-semantic-evidence-'));
  const path = join(root, OCR_SEMANTIC_EVIDENCE_ARTIFACT);
  const evidence = buildOcrSemanticEvidence(completedDetail(), expectedIdentity());
  const identity = await writeOcrSemanticEvidenceArtifact(path, evidence);
  const bytes = await readFile(path);

  assert.equal(identity.path, OCR_SEMANTIC_EVIDENCE_ARTIFACT);
  assert.equal(identity.bytes, bytes.length);
  assert.equal(identity.sha256, sha256(bytes));
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), evidence);
  assert.equal((await readdir(root)).filter((name) => name.includes('.tmp-')).length, 0);
  await assert.rejects(
    () => writeOcrSemanticEvidenceArtifact(path, evidence),
    OcrSemanticEvidenceValidationError,
  );
  assert.equal((await stat(path)).isFile(), true);
  const manifestPath = await writeAcceptanceManifest(root, {
    project: 'capture-workbench',
    runId: 'run-2026-08-29',
    status: 'completed',
    recordVideo: false,
    artifacts: [{
      path,
      kind: 'report',
      expectedIdentity: { bytes: identity.bytes, sha256: identity.sha256 },
    }],
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
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    readonly artifacts: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
  };
  assert.deepEqual(manifest.artifacts, [{
    path: OCR_SEMANTIC_EVIDENCE_ARTIFACT,
    kind: 'report',
    bytes: identity.bytes,
    sha256: identity.sha256,
  }]);
});

test('manifest rejects a semantic artifact replacement after its atomic writer identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocr-semantic-evidence-replacement-'));
  const path = join(root, OCR_SEMANTIC_EVIDENCE_ARTIFACT);
  const evidence = buildOcrSemanticEvidence(completedDetail(), expectedIdentity());
  const identity = await writeOcrSemanticEvidenceArtifact(path, evidence);
  await writeFile(path, JSON.stringify({ ...evidence, runId: 'replacement' }, null, 2) + '\n');

  await assert.rejects(
    () => writeAcceptanceManifest(root, {
      project: 'capture-workbench',
      runId: 'run-2026-08-29',
      status: 'completed',
      recordVideo: false,
      artifacts: [{
        path,
        kind: 'report',
        expectedIdentity: { bytes: identity.bytes, sha256: identity.sha256 },
      }],
      cleanup: {
        app: true,
        sidecar: true,
        cdpPort: true,
        temporaryAppData: true,
        ownedPids: true,
        ownedListeners: true,
        ownedWorkers: true,
      },
    }),
    /changed after producer identity verification/u,
  );
});

test('installed smoke binds semantic evidence from one durable library_get snapshot', async () => {
  const smoke = await readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8');
  assert.match(smoke, /readDurableLibraryDetail\(page, importedDocumentId\)/u);
  assert.match(smoke, /buildOcrSemanticEvidence\(durableLibraryDetail/u);
  assert.match(smoke, /buildOcrOnlySemanticEvidence\(durableLibraryDetail/u);
  assert.match(smoke, /writeOcrSemanticEvidenceArtifact\(/u);
  assert.match(smoke, /join\(acceptance\.artifactRoot, semanticEvidence\.artifactPath\)/u);
  assert.match(smoke, /semanticArtifactIdentity\.path/u);
  assert.doesNotMatch(smoke, /writeOcrOnlySemanticEvidenceArtifact/u);
  assert.doesNotMatch(smoke, /runtime\.getOcr|runtime\.getRaw|runtime\.getResult/u);
});

function expectedIdentity(includeProof = true) {
  const identity = {
    runId: 'run-2026-08-29',
    fixtureName: 'ocr_test_image.jpeg',
    sourceKind: 'image' as const,
    sourceSha256: SOURCE_SHA,
    runtimeVersion: '0.4.2',
    runtimeSha256: RUNTIME_SHA,
    contractSha256: CONTRACT_SHA,
    workerSha256: WORKER_SHA,
    ocrEngine: 'windowsml-ocr',
    ocrModel: 'ppocrv6-traditional-multilingual',
    ocrDevice: 'windowsml-dml' as const,
    anchors: ['snow man'],
  };
  return includeProof ? {
    ...identity,
    executionProof: {
      sourceSha256: SOURCE_SHA,
      runtimeSha256: RUNTIME_SHA,
      workerSha256: WORKER_SHA,
      modelSha256: 'd'.repeat(64),
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
      contractSetSha256: CONTRACT_SHA,
      requestedPageScope: null,
      device: 'windowsml-dml' as const,
    },
  } : identity;
}

interface TestDetail {
  status: 'completed' | 'failed' | 'awaiting_confirmation';
  stage?: string;
  ocrEvidence: Record<string, unknown>;
  raw?: {
    source: Record<string, unknown>;
    sourceText: string;
    segments: Array<Record<string, unknown>>;
  };
  result?: {
    targetText: string;
    blocks: Array<Record<string, unknown>>;
  };
}

function ocrOnlyDetail(): TestDetail {
  const detail = completedDetail();
  delete detail.result;
  detail.status = 'awaiting_confirmation';
  detail.stage = 'awaiting_structuring';
  return detail;
}

function completedDetail(): TestDetail {
  const evidenceWithoutDigest = {
    schemaVersion: 1,
    captureId: 'capture-1',
    sourceSha256: SOURCE_SHA,
    status: 'completed',
    pageCount: 1,
    pages: [{
      page: 1,
      status: 'recognized',
      raster: { width: 1200, height: 800 },
      normalizedCharCount: 11,
      boxCount: 1,
      confidence: 0.875,
      confidenceSummary: {
        scoreState: 'numeric',
        numericCount: 1,
        min: 0.875,
        max: 0.875,
        mean: 0.875,
      },
    }],
    summary: {
      normalizedCharCount: 11,
      boxCount: 1,
      confidenceSummary: {
        scoreState: 'numeric',
        numericCount: 1,
        min: 0.875,
        max: 0.875,
        mean: 0.875,
      },
    },
    provenance: {
      status: 'resolved',
      runtimeVersion: '0.4.2',
      contractSha256: CONTRACT_SHA,
      engine: 'windowsml-ocr',
      model: 'ppocrv6-traditional-multilingual',
      modelDigest: `sha256:${'d'.repeat(64)}`,
      device: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
      workerSha256: WORKER_SHA,
    },
  };
  return {
    status: 'completed',
    ocrEvidence: { ...evidenceWithoutDigest, digest: sha256(canonicalJson(evidenceWithoutDigest)) },
    raw: {
      source: { sha256: SOURCE_SHA },
      sourceText: 'Snow man raw OCR',
      segments: [{ text: 'Snow man raw OCR' }],
    },
    result: {
      targetText: 'structured output',
      blocks: [{ sourceText: 'Snow man raw OCR', targetText: 'structured output' }],
    },
  };
}

function failedPdfDetail(): TestDetail {
  const base = completedDetail().ocrEvidence;
  const unavailable = {
    status: 'unavailable',
    runtimeVersion: '0.4.2',
    contractSha256: CONTRACT_SHA,
    engine: null,
    model: null,
    modelDigest: null,
    device: null,
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
    workerSha256: WORKER_SHA,
  };
  const page = (number: number, status: 'empty' | 'failed') => ({
    page: number,
    status,
    raster: { width: 1200, height: 800 },
    normalizedCharCount: 0,
    boxCount: 0,
    confidence: null,
    confidenceSummary: {
      scoreState: 'none',
      numericCount: 0,
      min: null,
      max: null,
      mean: null,
    },
    ...(status === 'failed' ? { failure: { code: 'ocr_worker_failed', message: 'OCR failure: ocr_worker_failed.' } } : {}),
  });
  const baseWithoutDigest = { ...base };
  delete baseWithoutDigest.digest;
  const evidenceWithoutDigest = {
    ...baseWithoutDigest,
    captureId: 'capture-pdf-failed',
    sourceSha256: SOURCE_SHA,
    status: 'failed',
    pageCount: 2,
    pages: [page(1, 'empty'), page(2, 'failed')],
    provenance: unavailable,
    summary: {
      normalizedCharCount: 0,
      boxCount: 0,
      confidenceSummary: { scoreState: 'none', numericCount: 0, min: null, max: null, mean: null },
    },
    failure: { code: 'ocr_worker_failed', message: 'OCR failure: ocr_worker_failed.' },
  };
  return {
    status: 'failed',
    ocrEvidence: { ...evidenceWithoutDigest, digest: sha256(canonicalJson(evidenceWithoutDigest)) },
  };
}

function expectSha256OfDurableEvidence(): string {
  return String(completedDetail().ocrEvidence.digest);
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}
