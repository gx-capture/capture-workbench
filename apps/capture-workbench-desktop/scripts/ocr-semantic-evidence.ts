import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { normalizeOcrText } from './real-ocr-result-assertions.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const MODEL_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_PAGES = 500;
const MAX_FAILURE_MESSAGE_LENGTH = 128;

export const OCR_SEMANTIC_EVIDENCE_ARTIFACT = 'ocr-semantic-evidence-v1.json' as const;

export type SemanticOcrSourceKind = 'image' | 'pdf';
export type SemanticOcrDevice = 'windowsml-dml' | 'cpu';

/** Identity independently authenticated by the runtime execution-proof sink. */
export interface OcrSemanticExecutionProofIdentity {
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  readonly workerSha256: string;
  readonly modelSha256: string;
  readonly profileId: string;
  readonly profileSpecSha256: string;
  readonly contractSetSha256: string;
  readonly requestedPageScope: readonly number[] | null;
  readonly device: SemanticOcrDevice;
}

export interface OcrSemanticEvidenceExpectedIdentity {
  readonly runId: string;
  readonly fixtureName: string;
  readonly sourceKind: SemanticOcrSourceKind;
  readonly sourceSha256: string;
  readonly runtimeVersion: string;
  readonly runtimeSha256: string;
  readonly contractSha256: string;
  readonly workerSha256: string;
  readonly ocrEngine: string;
  readonly ocrModel: string;
  /** The compute mode was authenticated by the installed-app preflight/UI. */
  readonly ocrDevice: SemanticOcrDevice;
  readonly anchors: readonly string[];
  readonly executionProof?: OcrSemanticExecutionProofIdentity;
  readonly captureId?: string;
}

export interface OcrSemanticPageV1 {
  readonly page: number;
  readonly status: 'recognized' | 'empty' | 'failed';
  readonly normalizedCharCount: number;
  readonly boxCount: number;
  readonly confidence: number | null;
  readonly confidenceSummary: OcrSemanticConfidenceSummaryV1;
  readonly failure?: OcrSemanticFailureV1;
}

export interface OcrSemanticConfidenceSummaryV1 {
  readonly scoreState: 'numeric' | 'none';
  readonly numericCount: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
}

export interface OcrSemanticFailureV1 {
  readonly code: string;
  readonly message: string;
  readonly stage?: string;
  readonly retryable?: boolean;
}

export interface OcrSemanticProvenanceV1 {
  readonly runtimeVersion: string;
  readonly contractSha256: string;
  readonly engine: string | null;
  readonly model: string | null;
  readonly modelDigest: string | null;
  readonly device: string | null;
  readonly profileId: string;
  readonly profileSpecSha256: string;
  readonly workerSha256: string;
}

/**
 * Privacy-safe semantic evidence for one durable installed-app OCR journey.
 * The manifest owns the bytes/SHA identity of this artifact; this record owns
 * only stable counts and authenticated provenance, never OCR content.
 */
export interface OcrSemanticEvidenceV1 {
  readonly schemaVersion: 1;
  readonly artifactPath: typeof OCR_SEMANTIC_EVIDENCE_ARTIFACT;
  readonly runId: string;
  readonly fixtureName: string;
  readonly sourceKind: SemanticOcrSourceKind;
  readonly sourceSha256: string;
  readonly captureId: string;
  readonly status: 'completed' | 'failed';
  readonly ocrDevice: SemanticOcrDevice;
  readonly pageCount: number;
  readonly pages: readonly OcrSemanticPageV1[];
  readonly provenance: OcrSemanticProvenanceV1;
  readonly rawNonEmpty: boolean;
  readonly rawSegmentCount: number;
  readonly rawNonEmptySegmentCount: number;
  readonly resultNonEmpty: boolean;
  readonly resultBlockCount: number;
  readonly resultNonEmptyBlockCount: number;
  readonly criticalAnchors: {
    readonly expectedCount: number;
    readonly matchedCount: number;
  };
  /** Digest of the durable capture-runtime OCR evidence record. */
  readonly evidenceDigest: string;
  readonly failure?: OcrSemanticFailureV1;
}

export interface OcrSemanticArtifactIdentity {
  readonly path: typeof OCR_SEMANTIC_EVIDENCE_ARTIFACT;
  readonly bytes: number;
  readonly sha256: string;
}

export class OcrSemanticEvidenceValidationError extends Error {
  constructor(message: string) {
    super(`Invalid OCR semantic evidence: ${message}`);
    this.name = 'OcrSemanticEvidenceValidationError';
  }
}

/**
 * Projects only a durable `library_get` detail. The runtime capture is not
 * queried, and all source/result text is used only as transient validation
 * input for non-empty and approved-anchor checks.
 */
export function buildOcrSemanticEvidence(
  detail: unknown,
  expected: OcrSemanticEvidenceExpectedIdentity,
): OcrSemanticEvidenceV1 {
  const identity = validateExpectedIdentity(expected);
  const library = record(detail, 'library detail');
  const evidence = validateDurableOcrEvidence(library.ocrEvidence, identity);
  if (library.status !== evidence.status) invalid('library status does not match OCR evidence status');

  const raw = readRawSummary(library.raw, identity.sourceSha256);
  const result = readResultSummary(library.result);
  const anchors = countAnchors(raw.sourceText, identity.anchors);
  const pages = evidence.pages.map((page, index) => toSemanticPage(page, index + 1));

  if (evidence.status === 'completed') {
    if (!raw.present || !result.present || !raw.nonEmpty || !result.nonEmpty) {
      invalid('completed library detail must retain non-empty raw and result');
    }
    if (anchors.matchedCount !== anchors.expectedCount) invalid('critical OCR anchor was not found');
  }
  if (identity.sourceKind === 'image') {
    if (evidence.status !== 'completed' || evidence.pageCount !== 1 || pages[0]?.status !== 'recognized') {
      invalid('real image OCR must be one recognized page');
    }
    const page = pages[0];
    if (page.normalizedCharCount <= 0 || page.boxCount <= 0 || page.confidenceSummary.numericCount <= 0) {
      invalid('real image OCR must have characters, boxes, and numeric confidence');
    }
  }

  const outputWithoutFailure = {
    schemaVersion: 1 as const,
    artifactPath: OCR_SEMANTIC_EVIDENCE_ARTIFACT,
    runId: identity.runId,
    fixtureName: identity.fixtureName,
    sourceKind: identity.sourceKind,
    sourceSha256: identity.sourceSha256,
    captureId: evidence.captureId,
    status: evidence.status,
    ocrDevice: identity.executionProof?.device ?? identity.ocrDevice,
    pageCount: evidence.pageCount,
    pages,
    provenance: toSemanticProvenance(evidence.provenance),
    rawNonEmpty: raw.nonEmpty,
    rawSegmentCount: raw.segmentCount,
    rawNonEmptySegmentCount: raw.nonEmptySegmentCount,
    resultNonEmpty: result.nonEmpty,
    resultBlockCount: result.blockCount,
    resultNonEmptyBlockCount: result.nonEmptyBlockCount,
    criticalAnchors: anchors,
    evidenceDigest: evidence.digest,
    ...(evidence.failure === undefined ? {} : { failure: toSemanticFailure(evidence.failure) }),
  };
  return outputWithoutFailure;
}

/**
 * Projects the durable OCR checkpoint before structuring has run. The
 * checkpoint deliberately has no structured result; the durable OCR evidence
 * and authenticated execution proof remain the only sources of semantic truth.
 */
export function buildOcrOnlySemanticEvidence(
  detail: unknown,
  expected: OcrSemanticEvidenceExpectedIdentity,
): OcrSemanticEvidenceV1 {
  const identity = validateExpectedIdentity(expected);
  const proof = identity.executionProof;
  if (proof === undefined) invalid('completed OCR execution proof identity is required');
  const library = record(detail, 'library detail');
  const evidence = validateDurableOcrEvidence(library.ocrEvidence, identity);
  if (library.status !== 'awaiting_confirmation') invalid('OCR-only library status must be awaiting_confirmation');
  if (library.stage !== 'awaiting_structuring') invalid('OCR-only library stage must be awaiting_structuring');
  if (library.result !== undefined && library.result !== null) invalid('OCR-only library must not persist a structured result');
  if (evidence.status !== 'completed') invalid('OCR-only durable OCR evidence must be completed');

  const raw = readRawSummary(library.raw, identity.sourceSha256);
  if (!raw.present || !raw.nonEmpty || raw.segmentCount <= 0) {
    invalid('OCR-only library detail must retain non-empty raw OCR');
  }
  const anchors = countAnchors(raw.sourceText, identity.anchors);
  if (anchors.matchedCount !== anchors.expectedCount) invalid('critical OCR anchor was not found');
  const pages = evidence.pages.map((page, index) => toSemanticPage(page, index + 1));

  if (identity.sourceKind === 'image') {
    if (evidence.pageCount !== 1 || pages[0]?.status !== 'recognized') {
      invalid('real image OCR must be one recognized page');
    }
    const page = pages[0];
    if (page.normalizedCharCount <= 0 || page.boxCount <= 0 || page.confidenceSummary.numericCount <= 0) {
      invalid('real image OCR must have characters, boxes, and numeric confidence');
    }
  }

  return {
    schemaVersion: 1,
    artifactPath: OCR_SEMANTIC_EVIDENCE_ARTIFACT,
    runId: identity.runId,
    fixtureName: identity.fixtureName,
    sourceKind: identity.sourceKind,
    sourceSha256: identity.sourceSha256,
    captureId: evidence.captureId,
    status: evidence.status,
    ocrDevice: proof.device,
    pageCount: evidence.pageCount,
    pages,
    provenance: toSemanticProvenance(evidence.provenance),
    rawNonEmpty: raw.nonEmpty,
    rawSegmentCount: raw.segmentCount,
    rawNonEmptySegmentCount: raw.nonEmptySegmentCount,
    resultNonEmpty: false,
    resultBlockCount: 0,
    resultNonEmptyBlockCount: 0,
    criticalAnchors: anchors,
    evidenceDigest: evidence.digest,
  };
}

/** Writes a semantic record atomically and returns the identity for manifest inclusion. */
export async function writeOcrSemanticEvidenceArtifact(
  filePath: string,
  evidence: OcrSemanticEvidenceV1,
): Promise<OcrSemanticArtifactIdentity> {
  if (basename(filePath) !== OCR_SEMANTIC_EVIDENCE_ARTIFACT) {
    throw new OcrSemanticEvidenceValidationError('artifact path must use the canonical filename');
  }
  validateSemanticEvidence(evidence);
  const destination = resolve(filePath);
  await mkdir(dirname(destination), { recursive: true });
  if (await stat(destination).then(() => true).catch(() => false)) {
    throw new OcrSemanticEvidenceValidationError('artifact already exists; refusing to overwrite');
  }
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return {
    path: OCR_SEMANTIC_EVIDENCE_ARTIFACT,
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
  };
}

function validateExpectedIdentity(value: unknown): OcrSemanticEvidenceExpectedIdentity {
  const expected = record(value, 'expected identity');
  exactKeys(expected, [
    'anchors',
    'contractSha256',
    'fixtureName',
    'ocrEngine',
    'ocrModel',
    'ocrDevice',
    'runId',
    'runtimeVersion',
    'runtimeSha256',
    'sourceKind',
    'sourceSha256',
    'workerSha256',
    ...(expected.executionProof === undefined ? [] : ['executionProof']),
    ...(expected.captureId === undefined ? [] : ['captureId']),
  ], 'expected identity');
  safeString(expected.runId, 'expected runId', 64, /^[A-Za-z0-9._-]+$/u);
  safeFixtureName(expected.fixtureName);
  if (expected.sourceKind !== 'image' && expected.sourceKind !== 'pdf') invalid('expected sourceKind');
  sha(expected.sourceSha256, 'expected sourceSha256');
  safeString(expected.runtimeVersion, 'expected runtimeVersion', 64);
  sha(expected.runtimeSha256, 'expected runtimeSha256');
  sha(expected.contractSha256, 'expected contractSha256');
  sha(expected.workerSha256, 'expected workerSha256');
  safeString(expected.ocrEngine, 'expected ocrEngine', 256);
  safeString(expected.ocrModel, 'expected ocrModel', 256);
  if (expected.ocrDevice !== 'windowsml-dml' && expected.ocrDevice !== 'cpu') invalid('expected ocrDevice');
  if (!Array.isArray(expected.anchors)) invalid('expected anchors');
  if (expected.anchors.some((anchor) => typeof anchor !== 'string' || !normalizeOcrText(anchor))) {
    invalid('expected anchors contain empty values');
  }
  if (new Set(expected.anchors.map(normalizeOcrText)).size !== expected.anchors.length) invalid('expected anchors are not unique');
  if (expected.captureId !== undefined) safeString(expected.captureId, 'expected captureId', 256);
  const identity = expected as unknown as OcrSemanticEvidenceExpectedIdentity;
  if (identity.executionProof !== undefined) validateExecutionProofIdentity(identity.executionProof, identity);
  return identity;
}

function validateExecutionProofIdentity(
  value: unknown,
  expected: OcrSemanticEvidenceExpectedIdentity,
): void {
  const proof = record(value, 'expected OCR execution proof identity');
  exactKeys(proof, [
    'contractSetSha256',
    'device',
    'modelSha256',
    'profileId',
    'profileSpecSha256',
    'requestedPageScope',
    'runtimeSha256',
    'sourceSha256',
    'workerSha256',
  ], 'expected OCR execution proof identity');
  sha(proof.sourceSha256, 'expected OCR proof sourceSha256');
  sha(proof.runtimeSha256, 'expected OCR proof runtimeSha256');
  sha(proof.workerSha256, 'expected OCR proof workerSha256');
  sha(proof.modelSha256, 'expected OCR proof modelSha256');
  safeString(proof.profileId, 'expected OCR proof profileId', 128);
  sha(proof.profileSpecSha256, 'expected OCR proof profileSpecSha256');
  sha(proof.contractSetSha256, 'expected OCR proof contractSetSha256');
  if (proof.device !== 'windowsml-dml' && proof.device !== 'cpu') invalid('expected OCR proof device');
  if (proof.requestedPageScope !== null && (
    !Array.isArray(proof.requestedPageScope)
    || proof.requestedPageScope.length < 1
    || proof.requestedPageScope.length > MAX_PAGES
    || proof.requestedPageScope.some((page, index) => page !== index + 1)
  )) invalid('expected OCR proof requestedPageScope');
  if (proof.sourceSha256 !== expected.sourceSha256) invalid('expected OCR proof sourceSha256 mismatch');
  if (proof.runtimeSha256 !== expected.runtimeSha256) invalid('expected OCR proof runtimeSha256 mismatch');
  if (proof.workerSha256 !== expected.workerSha256) invalid('expected OCR proof workerSha256 mismatch');
  if (proof.contractSetSha256 !== expected.contractSha256) invalid('expected OCR proof contractSetSha256 mismatch');
  if (proof.device !== expected.ocrDevice) invalid('expected OCR proof device mismatch');
}

function validateDurableOcrEvidence(
  value: unknown,
  expected: OcrSemanticEvidenceExpectedIdentity,
): DurableOcrEvidence {
  const evidence = record(value, 'durable OCR evidence');
  exactKeys(evidence, [
    'captureId',
    'digest',
    'pageCount',
    'pages',
    'provenance',
    'schemaVersion',
    'sourceSha256',
    'status',
    'summary',
    ...(evidence.failure === undefined ? [] : ['failure']),
  ], 'durable OCR evidence');
  if (evidence.schemaVersion !== 1) invalid('durable OCR evidence schemaVersion');
  safeString(evidence.captureId, 'durable captureId', 256);
  if (expected.captureId !== undefined && evidence.captureId !== expected.captureId) invalid('captureId mismatch');
  sha(evidence.sourceSha256, 'durable sourceSha256');
  if (evidence.sourceSha256 !== expected.sourceSha256) invalid('sourceSha256 mismatch');
  if (evidence.status !== 'completed' && evidence.status !== 'failed') invalid('durable status');
  sha(evidence.digest, 'durable evidence digest');
  if (sha256Bytes(Buffer.from(canonicalJson(withoutKey(evidence, 'digest')), 'utf8')) !== evidence.digest) {
    invalid('durable evidence digest mismatch');
  }
  if (!Number.isSafeInteger(evidence.pageCount) || Number(evidence.pageCount) < 0 || Number(evidence.pageCount) > MAX_PAGES) invalid('durable pageCount');
  if (!Array.isArray(evidence.pages) || evidence.pages.length !== evidence.pageCount) invalid('durable pages/pageCount');
  const pages = evidence.pages as readonly unknown[];
  pages.forEach((page, index) => validateDurablePage(page, index + 1));
  validateDurableSummary(evidence.summary);
  const provenance = validateDurableProvenance(evidence.provenance, expected);
  if (evidence.status === 'completed') {
    if (evidence.failure !== undefined && evidence.failure !== null) invalid('completed durable failure');
    if (pages.some((page) => record(page, 'page').status === 'failed')) invalid('completed durable failed page');
    if (!pages.some((page) => record(page, 'page').status === 'recognized')) invalid('completed durable recognized page');
    if (provenance.status !== 'resolved') invalid('completed durable provenance');
  } else {
    if (evidence.failure === undefined || evidence.failure === null) invalid('failed durable failure');
    validateDurableFailure(evidence.failure, 'durable failure');
  }
  return evidence as unknown as DurableOcrEvidence;
}

interface DurableOcrEvidence {
  readonly captureId: string;
  readonly digest: string;
  readonly pageCount: number;
  readonly pages: readonly unknown[];
  readonly provenance: Record<string, unknown>;
  readonly sourceSha256: string;
  readonly status: 'completed' | 'failed';
  readonly summary: unknown;
  readonly failure?: unknown;
}

function validateDurablePage(value: unknown, expectedPage: number): void {
  const page = record(value, `durable page ${expectedPage}`);
  exactKeys(page, [
    'boxCount',
    'confidence',
    'confidenceSummary',
    'normalizedCharCount',
    'page',
    'raster',
    'status',
    ...(page.failure === undefined ? [] : ['failure']),
  ], `durable page ${expectedPage}`);
  if (page.page !== expectedPage) invalid(`durable page ${expectedPage} ordering`);
  if (page.status !== 'recognized' && page.status !== 'empty' && page.status !== 'failed') invalid(`durable page ${expectedPage} status`);
  positiveInteger(page.raster, 'width', `durable page ${expectedPage} raster width`);
  positiveInteger(page.raster, 'height', `durable page ${expectedPage} raster height`);
  nonNegativeInteger(page.normalizedCharCount, `durable page ${expectedPage} normalizedCharCount`);
  nonNegativeInteger(page.boxCount, `durable page ${expectedPage} boxCount`);
  validateConfidenceSummary(page.confidenceSummary, `durable page ${expectedPage} confidenceSummary`);
  if (page.status === 'recognized') {
    canonicalConfidence(page.confidence, `durable page ${expectedPage} confidence`);
    if (page.normalizedCharCount <= 0 || page.failure !== undefined) invalid(`durable recognized page ${expectedPage} shape`);
  } else if (page.status === 'empty') {
    if (page.confidence !== null || page.normalizedCharCount !== 0 || page.boxCount !== 0 || page.failure !== undefined) invalid(`durable empty page ${expectedPage} shape`);
  } else {
    if (page.confidence !== null || page.normalizedCharCount !== 0 || page.boxCount !== 0 || page.failure === undefined) invalid(`durable failed page ${expectedPage} shape`);
    validateDurableFailure(page.failure, `durable page ${expectedPage} failure`);
  }
}

function validateDurableSummary(value: unknown): void {
  const summary = record(value, 'durable summary');
  exactKeys(summary, ['boxCount', 'confidenceSummary', 'normalizedCharCount'], 'durable summary');
  nonNegativeInteger(summary.normalizedCharCount, 'durable summary normalizedCharCount');
  nonNegativeInteger(summary.boxCount, 'durable summary boxCount');
  validateConfidenceSummary(summary.confidenceSummary, 'durable summary confidenceSummary');
}

function validateConfidenceSummary(value: unknown, label: string): void {
  const summary = record(value, label);
  exactKeys(summary, ['max', 'mean', 'min', 'numericCount', 'scoreState'], label);
  nonNegativeInteger(summary.numericCount, `${label} numericCount`);
  if (summary.scoreState !== 'numeric' && summary.scoreState !== 'none') invalid(`${label} scoreState`);
  if (summary.scoreState === 'none') {
    if (summary.numericCount !== 0 || summary.min !== null || summary.max !== null || summary.mean !== null) invalid(`${label} none shape`);
  } else {
    if (summary.numericCount <= 0) invalid(`${label} numeric count`);
    canonicalConfidence(summary.min, `${label} min`);
    canonicalConfidence(summary.max, `${label} max`);
    canonicalConfidence(summary.mean, `${label} mean`);
  }
}

function validateDurableProvenance(value: unknown, expected: OcrSemanticEvidenceExpectedIdentity): Record<string, unknown> & { readonly status: string } {
  const provenance = record(value, 'durable provenance');
  exactKeys(provenance, ['contractSha256', 'device', 'engine', 'model', 'modelDigest', 'profileId', 'profileSpecSha256', 'runtimeVersion', 'status', 'workerSha256'], 'durable provenance');
  if (provenance.runtimeVersion !== expected.runtimeVersion) invalid('runtimeVersion mismatch');
  sha(provenance.contractSha256, 'durable contractSha256');
  if (provenance.contractSha256 !== expected.contractSha256) invalid('contractSha256 mismatch');
  sha(provenance.profileSpecSha256, 'durable profileSpecSha256');
  sha(provenance.workerSha256, 'durable workerSha256');
  if (provenance.workerSha256 !== expected.workerSha256) invalid('workerSha256 mismatch');
  safeString(provenance.profileId, 'durable profileId', 256);
  if (provenance.status === 'resolved') {
    safeString(provenance.engine, 'durable engine', 256);
    if (provenance.engine !== 'windowsml-ocr') invalid('durable engine');
    safeString(provenance.model, 'durable model', 256);
    if (provenance.engine !== expected.ocrEngine) invalid('durable engine mismatch');
    if (provenance.model !== expected.ocrModel) invalid('durable model mismatch');
    if (typeof provenance.modelDigest !== 'string' || !MODEL_DIGEST.test(provenance.modelDigest)) invalid('durable modelDigest');
    if (provenance.modelDigest === `sha256:${'0'.repeat(64)}`) invalid('durable modelDigest');
    safeString(provenance.device, 'durable device', 256);
    const proof = expected.executionProof;
    if (proof === undefined) invalid('completed OCR execution proof identity is required');
    if (provenance.modelDigest !== `sha256:${proof.modelSha256}`) invalid('durable modelDigest does not match execution proof');
    if (provenance.profileId !== proof.profileId) invalid('durable profileId does not match execution proof');
    if (provenance.profileSpecSha256 !== proof.profileSpecSha256) invalid('durable profileSpecSha256 does not match execution proof');
    if (provenance.workerSha256 !== proof.workerSha256) invalid('durable workerSha256 does not match execution proof');
    if (provenance.contractSha256 !== proof.contractSetSha256) invalid('durable contractSha256 does not match execution proof');
  } else if (provenance.status === 'unavailable') {
    if (provenance.engine !== null || provenance.model !== null || provenance.modelDigest !== null || provenance.device !== null) invalid('durable unavailable provenance');
  } else {
    invalid('durable provenance status');
  }
  return provenance as Record<string, unknown> & { readonly status: string };
}

function validateDurableFailure(value: unknown, label: string): void {
  const failure = record(value, label);
  exactKeys(failure, ['code', 'message', ...(failure.stage === undefined ? [] : ['stage']), ...(failure.retryable === undefined ? [] : ['retryable'])], label);
  safeString(failure.code, `${label} code`, 64, /^[a-z][a-z0-9_]{1,63}$/u);
  if (failure.message !== `OCR failure: ${failure.code}.`) invalid(`${label} message`);
  if (typeof failure.message !== 'string' || failure.message.length > MAX_FAILURE_MESSAGE_LENGTH) invalid(`${label} message`);
  if (failure.stage !== undefined) safeString(failure.stage, `${label} stage`, 64, /^[a-z][a-z0-9_.-]{0,63}$/u);
  if (failure.retryable !== undefined && typeof failure.retryable !== 'boolean') invalid(`${label} retryable`);
}

function toSemanticPage(value: unknown, expectedPage: number): OcrSemanticPageV1 {
  const page = record(value, `durable page ${expectedPage}`);
  return {
    page: expectedPage,
    status: page.status as OcrSemanticPageV1['status'],
    normalizedCharCount: page.normalizedCharCount as number,
    boxCount: page.boxCount as number,
    confidence: page.confidence as number | null,
    confidenceSummary: page.confidenceSummary as OcrSemanticConfidenceSummaryV1,
    ...(page.failure === undefined ? {} : { failure: toSemanticFailure(page.failure) }),
  };
}

function toSemanticProvenance(value: Record<string, unknown>): OcrSemanticProvenanceV1 {
  return {
    runtimeVersion: value.runtimeVersion as string,
    contractSha256: value.contractSha256 as string,
    engine: value.engine as string | null,
    model: value.model as string | null,
    modelDigest: value.modelDigest as string | null,
    device: value.device as string | null,
    profileId: value.profileId as string,
    profileSpecSha256: value.profileSpecSha256 as string,
    workerSha256: value.workerSha256 as string,
  };
}

function toSemanticFailure(value: unknown): OcrSemanticFailureV1 {
  const failure = record(value, 'failure');
  return {
    code: failure.code as string,
    message: failure.message as string,
    ...(failure.stage === undefined ? {} : { stage: failure.stage as string }),
    ...(failure.retryable === undefined ? {} : { retryable: failure.retryable as boolean }),
  };
}

function readRawSummary(value: unknown, expectedSourceSha256: string): {
  readonly present: boolean;
  readonly sourceText: string;
  readonly nonEmpty: boolean;
  readonly segmentCount: number;
  readonly nonEmptySegmentCount: number;
} {
  if (value === undefined || value === null) return { present: false, sourceText: '', nonEmpty: false, segmentCount: 0, nonEmptySegmentCount: 0 };
  const raw = record(value, 'durable raw capture');
  const source = record(raw.source, 'durable raw source');
  sha(source.sha256, 'durable raw sourceSha256');
  if (source.sha256 !== expectedSourceSha256) invalid('durable raw sourceSha256 mismatch');
  if (typeof raw.sourceText !== 'string') invalid('durable raw sourceText');
  if (!Array.isArray(raw.segments)) invalid('durable raw segments');
  const nonEmptySegmentCount = raw.segments.filter((segment) => {
    const recordValue = record(segment, 'durable raw segment');
    return typeof recordValue.text === 'string' && recordValue.text.trim().length > 0;
  }).length;
  if (nonEmptySegmentCount !== raw.segments.length) invalid('durable raw contains an empty segment');
  return {
    present: true,
    sourceText: raw.sourceText,
    nonEmpty: raw.sourceText.trim().length > 0,
    segmentCount: raw.segments.length,
    nonEmptySegmentCount,
  };
}

function readResultSummary(value: unknown): {
  readonly present: boolean;
  readonly nonEmpty: boolean;
  readonly blockCount: number;
  readonly nonEmptyBlockCount: number;
} {
  if (value === undefined || value === null) return { present: false, nonEmpty: false, blockCount: 0, nonEmptyBlockCount: 0 };
  const result = record(value, 'durable result');
  if (typeof result.targetText !== 'string') invalid('durable result targetText');
  if (!Array.isArray(result.blocks)) invalid('durable result blocks');
  const nonEmptyBlockCount = result.blocks.filter((block) => {
    const recordValue = record(block, 'durable result block');
    return typeof recordValue.sourceText === 'string'
      && recordValue.sourceText.trim().length > 0
      && typeof recordValue.targetText === 'string'
      && recordValue.targetText.trim().length > 0;
  }).length;
  if (nonEmptyBlockCount !== result.blocks.length) invalid('durable result contains an empty block');
  return {
    present: true,
    nonEmpty: result.targetText.trim().length > 0,
    blockCount: result.blocks.length,
    nonEmptyBlockCount,
  };
}

export function countAnchors(sourceText: string, anchors: readonly string[]): { readonly expectedCount: number; readonly matchedCount: number } {
  const normalized = normalizeOcrText(sourceText);
  let cursor = 0;
  let matchedCount = 0;
  for (const anchor of anchors) {
    const normalizedAnchor = normalizeOcrText(anchor);
    const position = normalized.indexOf(normalizedAnchor, cursor);
    if (position < 0) return { expectedCount: anchors.length, matchedCount };
    cursor = position + normalizedAnchor.length;
    matchedCount += 1;
  }
  return { expectedCount: anchors.length, matchedCount };
}

function validateSemanticEvidence(value: OcrSemanticEvidenceV1): void {
  const evidence = record(value, 'semantic evidence');
  exactKeys(evidence, [
    'artifactPath',
    'captureId',
    'criticalAnchors',
    'evidenceDigest',
    'fixtureName',
    'ocrDevice',
    'pageCount',
    'pages',
    'provenance',
    'rawNonEmpty',
    'rawNonEmptySegmentCount',
    'rawSegmentCount',
    'resultBlockCount',
    'resultNonEmpty',
    'resultNonEmptyBlockCount',
    'runId',
    'schemaVersion',
    'sourceKind',
    'sourceSha256',
    'status',
    ...(evidence.failure === undefined ? [] : ['failure']),
  ], 'semantic evidence');
  if (evidence.schemaVersion !== 1 || evidence.artifactPath !== OCR_SEMANTIC_EVIDENCE_ARTIFACT) invalid('semantic artifact identity');
  safeString(evidence.runId, 'semantic runId', 64, /^[A-Za-z0-9._-]+$/u);
  safeFixtureName(evidence.fixtureName);
  if (evidence.sourceKind !== 'image' && evidence.sourceKind !== 'pdf') invalid('semantic sourceKind');
  sha(evidence.sourceSha256, 'semantic sourceSha256');
  safeString(evidence.captureId, 'semantic captureId', 256);
  if (evidence.status !== 'completed' && evidence.status !== 'failed') invalid('semantic status');
  if (evidence.ocrDevice !== 'windowsml-dml' && evidence.ocrDevice !== 'cpu') invalid('semantic ocrDevice');
  const pageCount = evidence.pageCount;
  nonNegativeInteger(pageCount, 'semantic pageCount');
  if (pageCount > MAX_PAGES) invalid('semantic pageCount');
  if (!Array.isArray(evidence.pages) || evidence.pages.length !== pageCount) invalid('semantic pages/pageCount');
  nonNegativeInteger(evidence.rawSegmentCount, 'semantic rawSegmentCount');
  nonNegativeInteger(evidence.rawNonEmptySegmentCount, 'semantic rawNonEmptySegmentCount');
  nonNegativeInteger(evidence.resultBlockCount, 'semantic resultBlockCount');
  nonNegativeInteger(evidence.resultNonEmptyBlockCount, 'semantic resultNonEmptyBlockCount');
  if (evidence.rawNonEmptySegmentCount > evidence.rawSegmentCount || evidence.resultNonEmptyBlockCount > evidence.resultBlockCount) invalid('semantic non-empty counts');
  if (typeof evidence.rawNonEmpty !== 'boolean' || typeof evidence.resultNonEmpty !== 'boolean') invalid('semantic non-empty flags');
  const anchors = record(evidence.criticalAnchors, 'semantic critical anchors');
  exactKeys(anchors, ['expectedCount', 'matchedCount'], 'semantic critical anchors');
  nonNegativeInteger(anchors.expectedCount, 'semantic expected anchor count');
  nonNegativeInteger(anchors.matchedCount, 'semantic matched anchor count');
  if (anchors.matchedCount > anchors.expectedCount) invalid('semantic anchor counts');
  sha(evidence.evidenceDigest, 'semantic evidenceDigest');
  if (evidence.failure !== undefined) validateDurableFailure(evidence.failure, 'semantic failure');
  evidence.pages.forEach((page, index) => {
    const current = record(page, `semantic page ${index + 1}`);
    if (current.page !== index + 1) invalid('semantic page ordering');
    if (current.status !== 'recognized' && current.status !== 'empty' && current.status !== 'failed') invalid('semantic page status');
    nonNegativeInteger(current.normalizedCharCount, 'semantic normalizedCharCount');
    nonNegativeInteger(current.boxCount, 'semantic boxCount');
    validateConfidenceSummary(current.confidenceSummary, 'semantic confidenceSummary');
    if (current.status === 'failed') {
      if (current.failure === undefined) invalid('semantic failed page failure');
      validateDurableFailure(current.failure, 'semantic page failure');
    }
  });
}

function safeFixtureName(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\\/\0]/u.test(value)) invalid('fixtureName');
}

function safeString(value: unknown, label: string, maxLength: number, pattern?: RegExp): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || (pattern && !pattern.test(value))) invalid(label);
}

function sha(value: unknown, label: string): void {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(label);
}

function canonicalConfidence(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || round4(value) !== value || Object.is(value, -0)) invalid(label);
}

function positiveInteger(value: unknown, key: string, label: string): void {
  const recordValue = record(value, label);
  if (!Number.isSafeInteger(recordValue[key]) || Number(recordValue[key]) <= 0) invalid(label);
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(label);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) invalid(`${label} fields`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const valueRecord = value as Record<string, unknown>;
  return `{${Object.keys(valueRecord).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(valueRecord[key])}`).join(',')}}`;
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function invalid(label: string): never {
  throw new OcrSemanticEvidenceValidationError(label);
}
