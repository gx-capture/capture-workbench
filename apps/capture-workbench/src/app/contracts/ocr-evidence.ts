import type {
  CaptureFailure,
  CaptureOcrProjection,
  OcrPageProjection,
  OcrProvenance,
} from '@gx-capture/capture-runtime-client';
import { defer, from, map, throwError, type Observable } from 'rxjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const MODEL_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_PAGES = 500;
const MAX_BOXES = 100_000;
const MAX_TEXT_LENGTH = 8_000_000;

/** The only identity a caller supplies to the privacy-safe OCR evidence seam. */
export interface OcrEvidenceExpectedIdentity {
  readonly captureId: string;
  readonly sourceSha256: string;
  readonly runtimeVersion: string;
  readonly contractSha256: string;
  readonly terminalStatus: CaptureOcrProjection['status'];
  readonly workerSha256: string;
}

export interface OcrEvidenceInput {
  readonly projection: CaptureOcrProjection;
  readonly expected: OcrEvidenceExpectedIdentity;
}

export interface OcrEvidenceFailureV1 {
  readonly code: string;
  readonly message: string;
  readonly stage?: string;
  readonly retryable?: boolean;
}

export interface OcrEvidenceConfidenceSummaryV1 {
  readonly scoreState: 'numeric' | 'none';
  readonly numericCount: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
}

export interface OcrEvidencePageV1 {
  readonly page: number;
  readonly status: 'recognized' | 'empty' | 'failed';
  readonly raster: {
    readonly width: number;
    readonly height: number;
  };
  readonly normalizedCharCount: number;
  readonly boxCount: number;
  /** Contract page confidence: numeric mean, 0 for recognized text with no scores, null otherwise. */
  readonly confidence: number | null;
  readonly confidenceSummary: OcrEvidenceConfidenceSummaryV1;
  readonly failure?: OcrEvidenceFailureV1;
}

export interface OcrEvidenceProvenanceV1 {
  readonly status: 'resolved' | 'unavailable';
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

export interface OcrEvidenceV1 {
  readonly schemaVersion: 1;
  readonly captureId: string;
  readonly sourceSha256: string;
  readonly status: CaptureOcrProjection['status'];
  readonly pageCount: number;
  readonly pages: readonly OcrEvidencePageV1[];
  readonly summary: {
    readonly normalizedCharCount: number;
    readonly boxCount: number;
    readonly confidenceSummary: OcrEvidenceConfidenceSummaryV1;
  };
  readonly provenance: OcrEvidenceProvenanceV1;
  readonly failure?: OcrEvidenceFailureV1;
  /** Lowercase SHA-256 of the canonical privacy-safe evidence payload. */
  readonly digest: string;
}

export class OcrEvidenceValidationError extends Error {
  constructor(message: string) {
    super(`Invalid OCR evidence: ${message}`);
    this.name = 'OcrEvidenceValidationError';
  }
}

/**
 * Build one deterministic, content-free evidence record from a runtime OCR projection.
 * The projection's text, box text, and polygon coordinates are validation inputs only.
 */
export function buildOcrEvidence(input: OcrEvidenceInput): Observable<OcrEvidenceV1> {
  return defer(() => {
    const expected = validateExpectedIdentity(input?.expected);
    const projection = validateProjection(input?.projection, expected);
    const provenance = toEvidenceProvenance(projection, expected.workerSha256);
    const internalPages = projection.pages.map((page) => toInternalEvidencePage(page));
    const pages = internalPages.map(({ evidence }) => evidence);
    const evidenceWithoutDigest = {
      schemaVersion: 1 as const,
      captureId: projection.captureId,
      sourceSha256: expected.sourceSha256,
      status: projection.status,
      pageCount: projection.pageCount,
      pages,
      summary: summarizePages(internalPages),
      provenance,
      ...(projection.failure ? { failure: toEvidenceFailure(projection.failure) } : {}),
    };
    return sha256$(canonicalJson(evidenceWithoutDigest)).pipe(
      map((digest) => ({ ...evidenceWithoutDigest, digest })),
    );
  });
}

function validateExpectedIdentity(value: unknown): OcrEvidenceExpectedIdentity {
  const expected = record(value, 'expected identity');
  requireExactKeys(expected, [
    'captureId',
    'sourceSha256',
    'runtimeVersion',
    'contractSha256',
    'terminalStatus',
    'workerSha256',
  ], 'expected identity');
  nonEmpty(expected['captureId'], 'expected captureId');
  sha(expected['sourceSha256'], 'expected sourceSha256');
  nonEmpty(expected['runtimeVersion'], 'expected runtimeVersion');
  sha(expected['contractSha256'], 'expected contractSha256');
  if (expected['terminalStatus'] !== 'completed' && expected['terminalStatus'] !== 'failed') {
    invalid('expected terminalStatus');
  }
  sha(expected['workerSha256'], 'expected workerSha256');
  return expected as unknown as OcrEvidenceExpectedIdentity;
}

function validateProjection(
  value: unknown,
  expected: OcrEvidenceExpectedIdentity,
): CaptureOcrProjection {
  const projection = record(value, 'projection');
  requireExactKeys(
    projection,
    ['apiVersion', 'schemaVersion', 'captureId', 'status', 'pages', 'pageCount', 'runtimeVersion', 'contractSha256', 'provenance', 'createdAt'],
    'projection',
    ['source', 'warnings', 'failure'],
  );
  if (projection['apiVersion'] !== '2.0' || projection['schemaVersion'] !== '3') {
    invalid('projection version');
  }
  nonEmpty(projection['captureId'], 'projection captureId');
  if (projection['captureId'] !== expected['captureId']) invalid('captureId does not match expected identity');
  if (projection['status'] !== 'completed' && projection['status'] !== 'failed') invalid('projection status');
  if (projection['status'] !== expected['terminalStatus']) invalid('terminal status does not match expected identity');
  nonEmpty(projection['runtimeVersion'], 'projection runtimeVersion');
  if (projection['runtimeVersion'] !== expected['runtimeVersion']) invalid('runtimeVersion does not match expected identity');
  sha(projection['contractSha256'], 'projection contractSha256');
  if (projection['contractSha256'] !== expected['contractSha256']) invalid('contractSha256 does not match expected identity');
  isoTimestamp(projection['createdAt'], 'projection createdAt');

  const sourceValue = projection['source'];
  if (sourceValue === undefined || sourceValue === null) {
    if (projection['status'] !== 'failed') invalid('projection source');
  } else {
    const source = record(sourceValue, 'projection source');
    requireExactKeys(source, ['sha256', 'fileName', 'mediaType', 'bytes'], 'projection source');
    sha(source['sha256'], 'projection sourceSha256');
    if (source['sha256'] !== expected['sourceSha256']) invalid('sourceSha256 does not match expected identity');
    nonEmpty(source['fileName'], 'projection source fileName');
    nonEmpty(source['mediaType'], 'projection source mediaType');
    safeInteger(source['bytes'], 'projection source bytes', 1);
  }

  if (!Number.isSafeInteger(projection['pageCount']) || (projection['pageCount'] as number) < 0 || (projection['pageCount'] as number) > MAX_PAGES) {
    invalid('projection pageCount');
  }
  if (!Array.isArray(projection['pages']) || projection['pages'].length !== (projection['pageCount'] as number)) {
    invalid('projection pages/pageCount');
  }
  const documentProvenance = validateProvenance(projection['provenance']);
  const pages = projection['pages'] as readonly unknown[];
  pages.forEach((value, index) => validatePage(value, index + 1, documentProvenance));
  if (projection['status'] === 'completed') {
    if (projection['failure'] !== undefined && projection['failure'] !== null) invalid('completed projection failure');
    if (pages.some((value) => record(value, 'page')['status'] === 'failed')) invalid('completed projection contains failed page');
    if (!pages.some((value) => record(value, 'page')['status'] === 'recognized')) invalid('completed projection requires recognized page');
    if (documentProvenance.status !== 'resolved') invalid('completed projection provenance');
  } else {
    if (projection['failure'] === undefined || projection['failure'] === null) invalid('failed projection failure');
    validateFailure(projection['failure'], 'projection failure');
  }
  return projection as unknown as CaptureOcrProjection;
}

function validatePage(value: unknown, expectedPage: number, documentProvenance: OcrProvenance): void {
  const page = record(value, `page ${expectedPage}`);
  requireExactKeys(page, ['page', 'status', 'raster', 'provenance'], `page ${expectedPage}`, ['text', 'boxes', 'confidence', 'failure']);
  if (page['page'] !== expectedPage) invalid(`page ${expectedPage} ordering`);
  if (page['status'] !== 'recognized' && page['status'] !== 'empty' && page['status'] !== 'failed') invalid(`page ${expectedPage} status`);
  const raster = record(page['raster'], `page ${expectedPage} raster`);
  requireExactKeys(raster, ['width', 'height', 'scale', 'coordinateSystem'], `page ${expectedPage} raster`);
  safeInteger(raster['width'], `page ${expectedPage} raster width`, 1);
  safeInteger(raster['height'], `page ${expectedPage} raster height`, 1);
  finitePositiveAtMost(raster['scale'], `page ${expectedPage} raster scale`, 8);
  if (raster['coordinateSystem'] !== 'pixel') invalid(`page ${expectedPage} raster coordinateSystem`);

  const provenance = validateProvenance(page['provenance']);
  if (!sameProvenance(provenance, documentProvenance)) invalid(`page ${expectedPage} provenance mismatch`);
  const text = page['text'];
  if (text !== undefined && typeof text !== 'string') invalid(`page ${expectedPage} text`);
  if (typeof text === 'string' && text.length > MAX_TEXT_LENGTH) invalid(`page ${expectedPage} text length`);
  const boxes = page['boxes'];
  if (boxes !== undefined && (!Array.isArray(boxes) || boxes.length > MAX_BOXES)) invalid(`page ${expectedPage} boxes`);
  if (Array.isArray(boxes)) boxes.forEach((box, index) => validateBox(box, raster, `page ${expectedPage} box ${index}`));
  const confidence = page['confidence'];
  if (confidence !== undefined && confidence !== null) canonicalConfidence(confidence, `page ${expectedPage} confidence`);
  if (page['failure'] !== undefined && page['failure'] !== null) validateFailure(page['failure'], `page ${expectedPage} failure`);

  const textValue = typeof text === 'string' ? text : '';
  const boxValues = Array.isArray(boxes) ? boxes : [];
  if (page['status'] === 'recognized') {
    if (!textValue.trim() || page['failure'] !== undefined && page['failure'] !== null || typeof confidence !== 'number') {
      invalid(`recognized page ${expectedPage} shape`);
    }
  } else if (page['status'] === 'empty') {
    if (textValue.trim() || boxValues.length > 0 || confidence !== undefined && confidence !== null || page['failure'] !== undefined && page['failure'] !== null) {
      invalid(`empty page ${expectedPage} shape`);
    }
  } else if (textValue.trim() || boxValues.length > 0 || confidence !== undefined && confidence !== null || page['failure'] === undefined || page['failure'] === null) {
    invalid(`failed page ${expectedPage} shape`);
  }
  if ((page['status'] === 'recognized' || page['status'] === 'empty') && provenance.status !== 'resolved') {
    invalid(`page ${expectedPage} provenance status`);
  }
}

function validateBox(value: unknown, raster: Record<string, unknown>, label: string): void {
  const box = record(value, label);
  requireExactKeys(box, ['polygon', 'text', 'confidence'], label);
  if (!Array.isArray(box['polygon']) || box['polygon'].length < 4 || box['polygon'].length > 256) invalid(`${label} polygon`);
  box['polygon'].forEach((value, index) => {
    const point = record(value, `${label} point ${index}`);
    requireExactKeys(point, ['x', 'y'], `${label} point ${index}`);
    finiteNonNegative(point['x'], `${label} point ${index} x`);
    finiteNonNegative(point['y'], `${label} point ${index} y`);
    if ((point['x'] as number) > (raster['width'] as number) || (point['y'] as number) > (raster['height'] as number)) invalid(`${label} point bounds`);
  });
  nonEmpty(box['text'], `${label} text`);
  if ((box['text'] as string).length > MAX_TEXT_LENGTH) invalid(`${label} text length`);
  if (box['confidence'] !== null) boundedNumber(box['confidence'], `${label} confidence`);
}

function validateProvenance(value: unknown): OcrProvenance {
  const provenance = record(value, 'OCR provenance');
  if (provenance['status'] === 'resolved') {
    requireExactKeys(provenance, ['status', 'engine', 'model', 'modelDigest', 'device', 'profileId', 'profileSpecSha256'], 'resolved OCR provenance');
    if (provenance['engine'] !== 'windowsml-ocr') invalid('OCR provenance engine');
    nonEmpty(provenance['model'], 'OCR provenance model');
    if (typeof provenance['modelDigest'] !== 'string' || !MODEL_DIGEST.test(provenance['modelDigest'])) invalid('OCR provenance modelDigest');
    if (provenance['modelDigest'] === `sha256:${'0'.repeat(64)}`) invalid('OCR provenance modelDigest');
    nonEmpty(provenance['device'], 'OCR provenance device');
    nonEmpty(provenance['profileId'], 'OCR provenance profileId');
    sha(provenance['profileSpecSha256'], 'OCR provenance profileSpecSha256');
  } else if (provenance['status'] === 'unavailable') {
    requireExactKeys(provenance, ['status', 'profileId', 'profileSpecSha256', 'reason'], 'unavailable OCR provenance');
    nonEmpty(provenance['profileId'], 'unavailable OCR provenance profileId');
    sha(provenance['profileSpecSha256'], 'unavailable OCR provenance profileSpecSha256');
    if (!['model_unavailable', 'worker_crashed', 'worker_timeout', 'protocol_failure'].includes(provenance['reason'] as string)) invalid('unavailable OCR provenance reason');
  } else {
    invalid('OCR provenance status');
  }
  return provenance as unknown as OcrProvenance;
}

function validateFailure(value: unknown, label: string): void {
  const failure = record(value, label);
  requireExactKeys(failure, ['code', 'message'], label, ['stage', 'retryable']);
  if (typeof failure['code'] !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/u.test(failure['code'])) invalid(`${label} code`);
  nonEmpty(failure['message'], `${label} message`);
  if ((failure['message'] as string).length > 500) invalid(`${label} message length`);
  if (failure['stage'] !== undefined && failure['stage'] !== null && (typeof failure['stage'] !== 'string' || !failure['stage'].trim())) invalid(`${label} stage`);
  if (failure['retryable'] !== undefined && typeof failure['retryable'] !== 'boolean') invalid(`${label} retryable`);
}

interface InternalEvidencePage {
  readonly evidence: OcrEvidencePageV1;
  readonly numericScores: readonly number[];
}

function toInternalEvidencePage(pageValue: OcrPageProjection): InternalEvidencePage {
  const page = pageValue as unknown as Record<string, unknown>;
  const boxes = Array.isArray(page['boxes']) ? page['boxes'] : [];
  const numeric = boxes.map((value) => record(value, 'box')['confidence']).filter((value): value is number => typeof value === 'number');
  const confidenceSummary = summarizeConfidence(numeric);
  const status = page['status'] as OcrEvidencePageV1['status'];
  const output: OcrEvidencePageV1 = {
    page: page['page'] as number,
    status,
    raster: {
      width: (record(page['raster'], 'raster')['width'] as number),
      height: (record(page['raster'], 'raster')['height'] as number),
    },
    normalizedCharCount: status === 'recognized' ? normalizedCodePointCount(page['text'] as string) : 0,
    boxCount: boxes.length,
    confidence: status === 'recognized' ? page['confidence'] as number : null,
    confidenceSummary,
  };
  return {
    evidence: status === 'failed' ? { ...output, failure: toEvidenceFailure(page['failure'] as CaptureFailure) } : output,
    numericScores: numeric,
  };
}

function toEvidenceProvenance(projection: CaptureOcrProjection, workerSha256: string): OcrEvidenceProvenanceV1 {
  const provenance = projection['provenance'];
  if (provenance.status === 'resolved') {
    return {
      status: 'resolved',
      runtimeVersion: projection['runtimeVersion'],
      contractSha256: projection['contractSha256'],
      engine: provenance.engine,
      model: provenance.model,
      modelDigest: provenance.modelDigest,
      device: provenance.device,
      profileId: provenance.profileId,
      profileSpecSha256: provenance.profileSpecSha256,
      workerSha256,
    };
  }
  return {
    status: 'unavailable',
    runtimeVersion: projection['runtimeVersion'],
    contractSha256: projection['contractSha256'],
    engine: null,
    model: null,
    modelDigest: null,
    device: null,
    profileId: provenance.profileId,
    profileSpecSha256: provenance.profileSpecSha256,
    workerSha256,
  };
}

function toEvidenceFailure(value: CaptureFailure): OcrEvidenceFailureV1 {
  const failure = value as unknown as Record<string, unknown>;
  const output: OcrEvidenceFailureV1 = {
    code: failure['code'] as string,
    // Never carry an untrusted runtime message into durable evidence.
    message: `OCR failure: ${failure['code'] as string}.`,
  };
  const stage = typeof failure['stage'] === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/u.test(failure['stage'])
    ? failure['stage']
    : undefined;
  const retryable = typeof failure['retryable'] === 'boolean' ? failure['retryable'] : undefined;
  return {
    ...output,
    ...(stage === undefined ? {} : { stage }),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function summarizePages(pages: readonly InternalEvidencePage[]) {
  const numericScores = pages.flatMap(({ numericScores: scores }) => scores);
  return {
    normalizedCharCount: pages.reduce((sum, { evidence }) => sum + evidence.normalizedCharCount, 0),
    boxCount: pages.reduce((sum, { evidence }) => sum + evidence.boxCount, 0),
    confidenceSummary: summarizeConfidence(numericScores),
  };
}

function summarizeConfidence(values: readonly number[]): OcrEvidenceConfidenceSummaryV1 {
  if (values.length === 0) return { scoreState: 'none', numericCount: 0, min: null, max: null, mean: null };
  return {
    scoreState: 'numeric',
    numericCount: values.length,
    min: round4(Math.min(...values)),
    max: round4(Math.max(...values)),
    mean: round4(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function normalizedCodePointCount(value: string): number {
  const normalized = value.normalize('NFKC').replace(/\r\n?/gu, '\n').replace(/\s+/gu, ' ').trim();
  return Array.from(normalized).length;
}

function sameProvenance(left: OcrProvenance, right: OcrProvenance): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(recordValue[key])}`).join(',')}}`;
}

function sha256$(value: string): Observable<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return throwError(() => new OcrEvidenceValidationError('WebCrypto SHA-256 is unavailable'));
  }
  const bytes = new TextEncoder().encode(value);
  return defer(() => from(subtle.digest('SHA-256', bytes))).pipe(
    map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')),
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, required: readonly string[], label: string, optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) invalid(`${label} fields`);
}

function nonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim()) invalid(label);
}

function sha(value: unknown, label: string): void {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(label);
}

function safeInteger(value: unknown, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(label);
}

function finitePositive(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) invalid(label);
}

function finitePositiveAtMost(value: unknown, label: string, maximum: number): void {
  finitePositive(value, label);
  if ((value as number) > maximum) invalid(label);
}

function boundedNumber(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid(label);
}

function canonicalConfidence(value: unknown, label: string): void {
  boundedNumber(value, label);
  const confidence = value as number;
  if (Object.is(confidence, -0) || round4(confidence) !== confidence) invalid(`${label} must be canonical`);
}

function finiteNonNegative(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(label);
}

function isoTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) invalid(label);
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function invalid(label: string): never {
  throw new OcrEvidenceValidationError(label);
}
