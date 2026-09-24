import {
  CaptureAuthenticationError,
  CaptureRemoteError,
  CaptureRuntimeError,
  CaptureRuntimeProtocolError,
} from './errors.js';
import type {
  CaptureOcrProjection,
  ErrorEnvelope,
  RuntimeTransport,
  SubmitStructuringBatch,
} from './contracts.js';

/** Generated wire models whose top-level fields are checked before casting. */
export type RuntimeResponseModel =
  | 'RuntimeReady'
  | 'RuntimeStreamingCapabilities'
  | 'RuntimeRequirements'
  | 'RuntimeInstallation'
  | 'RuntimeInstallations'
  | 'RuntimeModelInstallation'
  | 'RuntimeModelOptions'
  | 'RawCapture'
  | 'CaptureOcrProjection'
  | 'CaptureDocument'
  | 'CaptureOperation'
  | 'Ingestion'
  | 'PartialCapture'
  | 'StreamingResult'
  | 'StructuringSession'
  | 'StructuringBatch';

const MODEL_FIELDS: Record<RuntimeResponseModel, { readonly required: readonly string[]; readonly optional: readonly string[] }> = {
  RuntimeReady: { required: ['ready', 'service', 'apiVersion', 'runtimeVersion', 'captureDocumentSchemaVersion', 'capabilities'], optional: ['message', 'captureDocumentSchemaSha256', 'schemaSha256', 'contractSetVersion', 'ocrCompute'] },
  RuntimeStreamingCapabilities: { required: ['protocolVersion', 'maxChunkBytes', 'checkpointIntervalMs', 'heartbeatIntervalMs', 'stallTimeoutMs'], optional: ['captureKinds', 'supportsProgressiveAudio'] },
  RuntimeRequirements: { required: ['items'], optional: [] },
  RuntimeInstallation: { required: ['installationId', 'requirementId', 'status', 'progress', 'createdAt', 'updatedAt'], optional: ['error', 'completedAt'] },
  RuntimeInstallations: { required: ['items'], optional: [] },
  RuntimeModelInstallation: { required: ['installationId', 'optionId', 'status', 'progress', 'createdAt', 'updatedAt'], optional: ['error', 'completedAt'] },
  RuntimeModelOptions: { required: ['catalogSha256', 'items'], optional: [] },
  RawCapture: { required: ['schemaVersion', 'diagnosticOnly', 'source', 'segments', 'sourceText', 'extractionEngine', 'createdAt'], optional: ['warnings'] },
  CaptureOcrProjection: { required: ['apiVersion', 'schemaVersion', 'captureId', 'status', 'pages', 'pageCount', 'runtimeVersion', 'contractSha256', 'provenance', 'createdAt'], optional: ['source', 'warnings', 'failure'] },
  CaptureDocument: { required: ['blocks', 'completedAt', 'createdAt', 'extractionEngine', 'rawSegments', 'schemaVersion', 'source', 'sourceText', 'structuringEngine', 'targetText'], optional: ['warnings'] },
  CaptureOperation: { required: ['protocolVersion', 'captureId', 'ingestionId', 'status', 'partialRevision', 'lastEventSequence', 'createdAt', 'updatedAt'], optional: ['kind', 'progress', 'source', 'error', 'completedAt'] },
  Ingestion: { required: ['protocolVersion', 'ingestionId', 'status', 'fileName', 'mediaType', 'totalBytes', 'receivedBytes', 'contiguousBytes', 'nextChunkIndex', 'nextOffset', 'expiresAt'], optional: ['kind', 'sourceSha256', 'finalizedSha256'] },
  PartialCapture: { required: ['protocolVersion', 'captureId', 'source', 'revision', 'coveredUntilMs', 'updatedAt'], optional: ['segments', 'sourceText', 'extractionEngine'] },
  StreamingResult: { required: ['operation', 'raw', 'result'], optional: [] },
  StructuringSession: { required: ['protocolVersion', 'sessionId', 'captureId', 'rawSourceSha256', 'contractSetSha256', 'providerCapability', 'schemaDialect', 'batchCount', 'nextBatchIndex', 'sessionDigest', 'status', 'createdAt', 'updatedAt'], optional: ['targetLanguage', 'completedAt'] },
  StructuringBatch: { required: ['protocolVersion', 'sessionId', 'captureId', 'batchIndex', 'batchCount', 'sourceSegmentIds', 'providerPrompt', 'providerSchema', 'numCtx', 'numPredict', 'batchDigest', 'status'], optional: [] },
};

export async function decodeJson<T>(response: Response, transport?: RuntimeTransport, model?: RuntimeResponseModel): Promise<T> {
  if (!response.ok) throw await decodeError(response);
  if (response.status === 204) return undefined as T;
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid JSON.', error);
  }
  if (value === undefined) throw new CaptureRuntimeProtocolError('Capture Runtime returned an empty response.');
  if (model) validateModelShape(value, model);
  return value as T;
}

/** Validate an already-decoded OCR projection at a host-owned transport seam. */
export function parseCaptureOcrProjection(value: unknown): CaptureOcrProjection {
  validateModelShape(value, 'CaptureOcrProjection');
  return value as CaptureOcrProjection;
}

function validateModelShape(value: unknown, model: RuntimeResponseModel): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${model} data.`);
  }
  const record = value as Record<string, unknown>;
  const fields = MODEL_FIELDS[model];
  const allowed = new Set([...fields.required, ...fields.optional]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned unknown ${model} field: ${unknown}.`);
  }
  const missing = fields.required.find((key) => !(key in record));
  if (missing) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned ${model} without required field: ${missing}.`);
  }
  if (model === 'CaptureOcrProjection') validateCaptureOcrProjection(record);
  if (model === 'RuntimeReady') validateRuntimeReady(record);
  if (model === 'StructuringSession') validateStructuringSession(record);
  if (model === 'StructuringBatch') validateStructuringBatch(record);
}

function validateRuntimeReady(record: Record<string, unknown>): void {
  const preflight = record['ocrCompute'];
  if (preflight === undefined || preflight === null) return;

  const compute = asRecord(preflight, 'RuntimeReady ocrCompute');
  assertExactFields(
    compute,
    [
      'apiVersion',
      'schemaVersion',
      'service',
      'runtimeVersion',
      'contractSetVersion',
      'contractSha256',
      'mode',
      'adapterClass',
      'userNoticeRequired',
    ],
    'RuntimeReady ocrCompute',
    ['workerSha256', 'reasonCode', 'noticeCode'],
  );
  if (
    compute['apiVersion'] !== '2.0' ||
    compute['schemaVersion'] !== '1' ||
    compute['service'] !== 'capture-runtime' ||
    compute['runtimeVersion'] !== '0.4.2' ||
    compute['contractSetVersion'] !== '2' ||
    typeof compute['contractSha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(compute['contractSha256']) ||
    (compute['workerSha256'] !== undefined &&
      compute['workerSha256'] !== null &&
      (typeof compute['workerSha256'] !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(compute['workerSha256']))) ||
    !isOcrComputeMode(compute['mode']) ||
    !isOcrAdapterClass(compute['adapterClass']) ||
    typeof compute['userNoticeRequired'] !== 'boolean'
  ) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an invalid OCR compute preflight.',
    );
  }

  const reasonCode = compute['reasonCode'];
  const noticeCode = compute['noticeCode'];
  if (
    reasonCode !== undefined &&
    reasonCode !== null &&
    !isOcrComputeReasonCode(reasonCode)
  ) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an invalid OCR compute reason code.',
    );
  }
  if (
    noticeCode !== undefined &&
    noticeCode !== null &&
    noticeCode !== 'ocr_cpu_fallback'
  ) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an invalid OCR compute notice code.',
    );
  }

  const hasFallbackReason = reasonCode !== undefined && reasonCode !== null;
  const hasNotice = noticeCode !== undefined && noticeCode !== null;
  if (compute['mode'] === 'gpu-dml') {
    if (hasFallbackReason || compute['userNoticeRequired'] || hasNotice) {
      throw new CaptureRuntimeProtocolError(
        'GPU-DML OCR compute preflight cannot carry a fallback reason or notice.',
      );
    }
    return;
  }

  if (
    !isOcrComputeReasonCode(reasonCode) ||
    compute['userNoticeRequired'] !== true ||
    noticeCode !== 'ocr_cpu_fallback'
  ) {
    throw new CaptureRuntimeProtocolError(
      'CPU-fallback OCR compute preflight requires a reason and user notice.',
    );
  }
}

function validateCaptureOcrProjection(record: Record<string, unknown>): void {
  if (record['apiVersion'] !== '2.0' || record['schemaVersion'] !== '3') {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an OCR projection with an incompatible version.',
    );
  }
  if (typeof record['captureId'] !== 'string' || !record['captureId'].trim()) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an OCR projection with an invalid captureId.',
    );
  }
  if (!isOcrProjectionStatus(record['status'])) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an OCR projection with an invalid status.',
    );
  }
  if (!isTimestamp(record['createdAt'])) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an OCR projection with an invalid createdAt.',
    );
  }
  if (
    !isSafeIntegerAtLeast(record['pageCount'], 0) ||
    (record['pageCount'] as number) > 500 ||
    record['pageCount'] !== (Array.isArray(record['pages']) ? record['pages'].length : -1)
  ) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an OCR projection with an invalid pageCount.',
    );
  }
  if (record['runtimeVersion'] !== '0.4.2') {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an OCR projection with an incompatible runtimeVersion.',
    );
  }
  if (
    typeof record['contractSha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record['contractSha256'])
  ) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned an OCR projection with an invalid contractSha256.',
    );
  }

  const source = record['source'];
  if (source !== undefined && source !== null) validateCaptureSource(source);
  const provenance = record['provenance'];
  validateOcrProvenance(provenance, 'OCR projection provenance');
  if (record['status'] === 'completed' && !isResolvedOcrProvenance(provenance)) {
    throw new CaptureRuntimeProtocolError(
      'Completed OCR projections require resolved provenance.',
    );
  }
  const failure = record['failure'];
  if (failure !== undefined && failure !== null)
    validateCaptureFailure(failure, 'OCR projection failure');
  const warnings = record['warnings'];
  if (warnings !== undefined) {
    if (!Array.isArray(warnings) || warnings.length > 1_000) {
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime returned invalid OCR projection warnings.',
      );
    }
    for (const warning of warnings) {
      if (typeof warning !== 'string' || warning.length > 500) {
        throw new CaptureRuntimeProtocolError(
          'Capture Runtime returned an invalid OCR projection warning.',
        );
      }
    }
  }

  const pages = record['pages'];
  if (!Array.isArray(pages) || pages.length > 500) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned invalid OCR projection pages.',
    );
  }
  const pageProjections: Record<string, unknown>[] = [];
  pages.forEach((value, index) => {
    const page = asRecord(value, 'OCR page projection');
    if (page['page'] !== index + 1) {
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime OCR pages must be complete and ordered from page one.',
      );
    }
    validateOcrPage(page, provenance);
    pageProjections.push(page);
  });

  if (record['status'] === 'completed') {
    if (
      pages.length === 0 ||
      source === undefined ||
      source === null ||
      failure !== undefined && failure !== null
    ) {
      throw new CaptureRuntimeProtocolError(
        'Completed OCR projections require pages, source, provenance, and no failure.',
      );
    }
    if (pageProjections.some((page) => page['status'] === 'failed')) {
      throw new CaptureRuntimeProtocolError(
        'Completed OCR projections must not contain failed pages.',
      );
    }
    if (!pageProjections.some((page) => page['status'] === 'recognized')) {
      throw new CaptureRuntimeProtocolError(
        'Completed OCR projections must contain recognized text.',
      );
    }
    if (
      pageProjections.some(
        (page) =>
          page['provenance'] === undefined ||
          page['provenance'] === null ||
          !sameOcrProvenance(page['provenance'], provenance),
      )
    ) {
      throw new CaptureRuntimeProtocolError(
        'Completed OCR pages require provenance matching the document provenance.',
      );
    }
  } else if (failure === undefined || failure === null) {
    throw new CaptureRuntimeProtocolError(
      'Failed OCR projections require a typed failure.',
    );
  }
}

function validateOcrPage(
  page: Record<string, unknown>,
  documentProvenance: unknown,
): void {
  assertExactFields(
    page,
    ['page', 'status', 'raster', 'provenance'],
    'OCR page projection',
    ['text', 'boxes', 'confidence', 'failure'],
  );
  if (!isSafeIntegerAtLeast(page['page'], 1) || !isOcrPageStatus(page['status'])) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned an invalid OCR page identity.');
  }
  validateOcrRaster(page['raster']);

  const text = page['text'];
  if (text !== undefined && typeof text !== 'string') {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid OCR page text.');
  }
  if (typeof text === 'string' && text.length > 8_000_000) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned OCR page text over the limit.');
  }

  const boxes = page['boxes'];
  if (boxes !== undefined && (!Array.isArray(boxes) || boxes.length > 100_000)) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid OCR page boxes.');
  }
  if (Array.isArray(boxes)) {
    for (const box of boxes) validateOcrBox(box, page['raster']);
  }

  const confidence = page['confidence'];
  if (
    confidence !== undefined &&
    confidence !== null &&
    (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid OCR page confidence.');
  }
  const provenance = page['provenance'];
  validateOcrProvenance(provenance, 'OCR page provenance');
  if (
    (page['status'] === 'recognized' || page['status'] === 'empty') &&
    !isResolvedOcrProvenance(provenance)
  ) {
    throw new CaptureRuntimeProtocolError(
      'Recognized and empty OCR pages require resolved provenance.',
    );
  }
  if (!sameOcrProvenance(provenance, documentProvenance)) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime page OCR provenance must match document provenance.',
    );
  }
  const failure = page['failure'];
  if (failure !== undefined && failure !== null)
    validateCaptureFailure(failure, 'OCR page failure');

  const textValue = typeof text === 'string' ? text : '';
  const boxValues = Array.isArray(boxes) ? boxes : [];
  if (page['status'] === 'recognized') {
    if (
      !textValue.trim() ||
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      (failure !== undefined && failure !== null)
    ) {
      throw new CaptureRuntimeProtocolError(
        'Recognized OCR pages require text and no failure.',
      );
    }
  } else if (page['status'] === 'empty') {
    if (
      textValue.trim() ||
      boxValues.length > 0 ||
      confidence !== undefined && confidence !== null ||
      failure !== undefined && failure !== null
    ) {
      throw new CaptureRuntimeProtocolError(
        'Empty OCR pages must not contain text, boxes, confidence, or failure.',
      );
    }
  } else if (
    textValue.trim() ||
    boxValues.length > 0 ||
    confidence !== undefined && confidence !== null ||
    failure === undefined ||
    failure === null
  ) {
    throw new CaptureRuntimeProtocolError(
      'Failed OCR pages require only a typed failure.',
    );
  }
}

function validateOcrRaster(value: unknown): void {
  const raster = asRecord(value, 'OCR raster');
  assertExactFields(raster, ['width', 'height', 'scale', 'coordinateSystem'], 'OCR raster');
  if (
    !isSafeIntegerAtLeast(raster['width'], 1) ||
    !isSafeIntegerAtLeast(raster['height'], 1) ||
    typeof raster['scale'] !== 'number' ||
    !Number.isFinite(raster['scale']) ||
    raster['scale'] <= 0 ||
    raster['scale'] > 8 ||
    raster['coordinateSystem'] !== 'pixel'
  ) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid OCR raster bounds.');
  }
}

function validateOcrBox(value: unknown, rasterValue: unknown): void {
  const box = asRecord(value, 'OCR box');
  assertExactFields(box, ['polygon', 'text', 'confidence'], 'OCR box');
  const raster = asRecord(rasterValue, 'OCR raster');
  const polygon = box['polygon'];
  if (!Array.isArray(polygon) || polygon.length < 4 || polygon.length > 256) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime OCR boxes must contain between four and 256 polygon points.',
    );
  }
  for (const pointValue of polygon) {
    const point = asRecord(pointValue, 'OCR polygon point');
    assertExactFields(point, ['x', 'y'], 'OCR polygon point');
    if (
      typeof point['x'] !== 'number' ||
      !Number.isFinite(point['x']) ||
      point['x'] < 0 ||
      point['x'] > (raster['width'] as number) ||
      typeof point['y'] !== 'number' ||
      !Number.isFinite(point['y']) ||
      point['y'] < 0 ||
      point['y'] > (raster['height'] as number)
    ) {
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime OCR polygon points must be finite, non-negative, and inside raster bounds.',
      );
    }
  }
  if (
    typeof box['text'] !== 'string' ||
    !box['text'].trim() ||
    box['text'].length > 8_000_000
  ) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid OCR box text.');
  }
  if (
    box['confidence'] !== null &&
    (typeof box['confidence'] !== 'number' ||
      !Number.isFinite(box['confidence']) ||
      box['confidence'] < 0 ||
      box['confidence'] > 1)
  ) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid OCR box confidence.');
  }
}

function validateCaptureSource(value: unknown): void {
  const source = asRecord(value, 'OCR source');
  assertExactFields(source, ['sha256', 'fileName', 'mediaType', 'bytes'], 'OCR source');
  if (
    typeof source['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(source['sha256']) ||
    typeof source['fileName'] !== 'string' ||
    !source['fileName'].trim() ||
    source['fileName'].length > 255 ||
    typeof source['mediaType'] !== 'string' ||
    !source['mediaType'].trim() ||
    !isSafeIntegerAtLeast(source['bytes'], 1)
  ) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid OCR source metadata.');
  }
}

function validateCaptureFailure(value: unknown, label: string): void {
  const failure = asRecord(value, label);
  assertExactFields(failure, ['code', 'message'], label, ['stage', 'retryable']);
  if (
    typeof failure['code'] !== 'string' ||
    !/^[a-z][a-z0-9_]{1,63}$/u.test(failure['code']) ||
    typeof failure['message'] !== 'string' ||
    !failure['message'].trim() ||
    failure['message'].length > 500 ||
    failure['stage'] !== undefined &&
      failure['stage'] !== null &&
      (typeof failure['stage'] !== 'string' || !failure['stage'].trim()) ||
    failure['retryable'] !== undefined && typeof failure['retryable'] !== 'boolean'
  ) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${label}.`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  );
}

function isOcrProjectionStatus(value: unknown): value is 'completed' | 'failed' {
  return value === 'completed' || value === 'failed';
}

function isOcrPageStatus(value: unknown): value is 'recognized' | 'empty' | 'failed' {
  return value === 'recognized' || value === 'empty' || value === 'failed';
}

function isOcrAdapterClass(
  value: unknown,
): value is 'dedicated' | 'integrated' | 'unknown' {
  return value === 'dedicated' || value === 'integrated' || value === 'unknown';
}

function isOcrComputeMode(value: unknown): value is 'gpu-dml' | 'cpu-fallback' {
  return value === 'gpu-dml' || value === 'cpu-fallback';
}

function isOcrComputeReasonCode(
  value: unknown,
): value is 'no_compatible_gpu' | 'dml_provider_unavailable' {
  return value === 'no_compatible_gpu' || value === 'dml_provider_unavailable';
}

function validateOcrProvenance(value: unknown, label: string): void {
  const provenance = asRecord(value, label);
  const status = provenance['status'];
  if (status === 'resolved') {
    assertExactFields(
      provenance,
      ['status', 'engine', 'model', 'modelDigest', 'device', 'profileId', 'profileSpecSha256'],
      label,
    );
    if (
      provenance['engine'] !== 'windowsml-ocr' ||
      typeof provenance['model'] !== 'string' ||
      !provenance['model'].trim() ||
      typeof provenance['modelDigest'] !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/u.test(provenance['modelDigest']) ||
      provenance['modelDigest'] === `sha256:${'0'.repeat(64)}` ||
      typeof provenance['device'] !== 'string' ||
      !provenance['device'].trim() ||
      typeof provenance['profileId'] !== 'string' ||
      !provenance['profileId'].trim() ||
      typeof provenance['profileSpecSha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(provenance['profileSpecSha256'])
    ) {
      throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${label}.`);
    }
    return;
  }
  if (status === 'unavailable') {
    assertExactFields(provenance, ['status', 'profileId', 'profileSpecSha256', 'reason'], label);
    if (
      typeof provenance['profileId'] !== 'string' ||
      !provenance['profileId'].trim() ||
      typeof provenance['profileSpecSha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(provenance['profileSpecSha256']) ||
      typeof provenance['reason'] !== 'string' ||
      !['model_unavailable', 'worker_crashed', 'worker_timeout', 'protocol_failure'].includes(
        provenance['reason'],
      )
    ) {
      throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${label}.`);
    }
    return;
  }
  throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${label}.`);
}

function isResolvedOcrProvenance(value: unknown): boolean {
  return asRecord(value, 'OCR provenance')['status'] === 'resolved';
}

function sameOcrProvenance(left: unknown, right: unknown): boolean {
  const leftRecord = asRecord(left, 'OCR page provenance');
  const rightRecord = asRecord(right, 'OCR projection provenance');
  return (
    leftRecord['status'] === rightRecord['status'] &&
    leftRecord['engine'] === rightRecord['engine'] &&
    leftRecord['model'] === rightRecord['model'] &&
    leftRecord['modelDigest'] === rightRecord['modelDigest'] &&
    leftRecord['device'] === rightRecord['device'] &&
    leftRecord['profileId'] === rightRecord['profileId'] &&
    leftRecord['profileSpecSha256'] === rightRecord['profileSpecSha256'] &&
    leftRecord['reason'] === rightRecord['reason']
  );
}

function validateStructuringSession(record: Record<string, unknown>): void {
  const provider = record['providerCapability'];
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid StructuringSession provider capability.');
  }
  assertExactFields(provider as Record<string, unknown>, ['provider', 'capability', 'schemaDialect'], 'StructuringSession provider capability');
  const engine = (provider as Record<string, unknown>)['provider'];
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid StructuringSession provider.');
  }
  assertExactFields(
    engine as Record<string, unknown>,
    ['engine', 'model', 'digest'],
    'StructuringSession provider',
    ['device'],
  );
  const device = (engine as Record<string, unknown>)['device'];
  if (
    device !== undefined &&
    device !== null &&
    (typeof device !== 'string' || device.length < 1)
  ) {
    throw new CaptureRuntimeProtocolError(
      'Capture Runtime returned invalid StructuringSession provider device.',
    );
  }
}

function validateStructuringBatch(record: Record<string, unknown>): void {
  const sourceSegmentIds = record['sourceSegmentIds'];
  if (!Array.isArray(sourceSegmentIds) || sourceSegmentIds.length < 1 || sourceSegmentIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned invalid StructuringBatch sourceSegmentIds.');
  }
  for (const field of ['providerPrompt', 'providerSchema']) {
    const value = record[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid StructuringBatch ${field}.`);
    }
  }
}

function assertExactFields(record: Record<string, unknown>, required: readonly string[], label: string, optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new CaptureRuntimeProtocolError(`Capture Runtime returned unknown ${label} field: ${unknown}.`);
  const missing = required.find((key) => !(key in record));
  if (missing) throw new CaptureRuntimeProtocolError(`Capture Runtime returned ${label} without required field: ${missing}.`);
}

/** Validate the strict minimal semantic batch body before sending it. */
export function assertStructuringBatchSubmission(value: unknown): asserts value is SubmitStructuringBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CaptureRuntimeProtocolError('Capture Runtime structuring batch submission must be an object.');
  }
  const body = value as Record<string, unknown>;
  assertExactFields(body, ['batchDigest', 'blocks'], 'structuring batch submission', ['protocolVersion']);
  if (body['protocolVersion'] !== undefined && body['protocolVersion'] !== '2') {
    throw new CaptureRuntimeProtocolError('Capture Runtime structuring batch submission protocolVersion is invalid.');
  }
  if (typeof body['batchDigest'] !== 'string' || !/^[0-9a-f]{64}$/u.test(body['batchDigest'])) {
    throw new CaptureRuntimeProtocolError('Capture Runtime structuring batch submission batchDigest is invalid.');
  }
  const blocks = body['blocks'];
  if (!Array.isArray(blocks) || blocks.length < 1) {
    throw new CaptureRuntimeProtocolError('Capture Runtime structuring batch submission blocks are invalid.');
  }
  const blockTypes = new Set(['heading', 'paragraph', 'list-item', 'table', 'quote', 'transcript']);
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new CaptureRuntimeProtocolError('Capture Runtime structuring batch submission block is invalid.');
    }
    const semantic = block as Record<string, unknown>;
    assertExactFields(semantic, ['sourceSegmentId', 'type'], 'structuring semantic block', ['targetText']);
    if (typeof semantic['sourceSegmentId'] !== 'string' || semantic['sourceSegmentId'].length === 0) {
      throw new CaptureRuntimeProtocolError('Capture Runtime structuring semantic block sourceSegmentId is invalid.');
    }
    if (typeof semantic['type'] !== 'string' || !blockTypes.has(semantic['type'])) {
      throw new CaptureRuntimeProtocolError('Capture Runtime structuring semantic block type is invalid.');
    }
    const targetText = semantic['targetText'];
    if (targetText !== undefined && targetText !== null && (typeof targetText !== 'string' || targetText.length < 1 || targetText.length > 2_000_000)) {
      throw new CaptureRuntimeProtocolError('Capture Runtime structuring semantic block targetText is invalid.');
    }
  }
}

export async function decodeError(response: Response): Promise<CaptureRuntimeError> {
  let envelope: ErrorEnvelope | undefined;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // Keep a stable error shape when a proxy returns HTML or an empty body.
  }
  const error = envelope?.error as (ErrorEnvelope['error'] & {
    readonly category?: unknown;
    readonly retryable?: unknown;
    readonly issues?: unknown;
    readonly requestId?: unknown;
  }) | undefined;
  const details = error?.details;
  const detailsMap = details && typeof details === 'object' ? details as Record<string, unknown> : {};
  const category = typeof error?.category === 'string'
    ? error.category
    : typeof detailsMap['category'] === 'string' ? detailsMap['category'] : undefined;
  const retryable = typeof error?.retryable === 'boolean'
    ? error.retryable
    : typeof detailsMap['retryable'] === 'boolean' ? detailsMap['retryable'] : response.status >= 500;
  const issues = Array.isArray(error?.issues)
    ? error.issues.filter((issue): issue is Record<string, unknown> => !!issue && typeof issue === 'object')
    : Array.isArray(detailsMap['issues'])
      ? detailsMap['issues'].filter((issue): issue is Record<string, unknown> => !!issue && typeof issue === 'object')
      : undefined;
  const requestId = response.headers.get('x-request-id')
    ?? response.headers.get('x-correlation-id')
    ?? (typeof error?.requestId === 'string' ? error.requestId : typeof detailsMap['requestId'] === 'string' ? detailsMap['requestId'] as string : undefined);
  const status = response.status;
  const code = error?.code ?? `http_${status}`;
  const message = error?.message ?? `Capture Runtime request failed (${status}).`;
  if (status === 401 || status === 403 || code === 'unauthorized' || code === 'authentication_failed') {
    return new CaptureAuthenticationError(message, status, details, requestId);
  }
  return new CaptureRemoteError(status, code, message, details, { category, retryable, issues, requestId });
}

export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

/** Parse a complete SSE response while retaining protocol bounds. */
export async function* decodeSse(response: Response): AsyncGenerator<SseFrame> {
  if (!response.ok) throw await decodeError(response);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('text/event-stream')) {
    throw new CaptureRuntimeProtocolError('Capture Runtime returned an invalid event stream.');
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frame: { id?: string; event?: string; data: string[] } = { data: [] };
  const flush = (): SseFrame | undefined => {
    if (frame.data.length === 0) {
      frame = { data: [] };
      return undefined;
    }
    const result: SseFrame = { id: frame.id, event: frame.event, data: frame.data.join('\n') };
    frame = { data: [] };
    return result;
  };
  while (true) {
    const next = await reader.read();
    buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const result = flush();
        if (result) yield result;
      } else if (line.startsWith(':')) {
        // Heartbeat comments intentionally do not produce a client event.
      } else {
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
        if (field === 'id') frame.id = value;
        else if (field === 'event') frame.event = value;
        else if (field === 'data') frame.data.push(value);
      }
      newline = buffer.indexOf('\n');
    }
    if (next.done) break;
  }
  if (buffer) {
    const line = buffer.replace(/\r$/u, '');
    if (line.startsWith('data:')) frame.data.push(line.slice(5).replace(/^ /u, ''));
  }
  const result = flush();
  if (result) yield result;
}

export function parseJsonFrame<T>(frame: SseFrame, label = 'event'): T {
  try {
    return JSON.parse(frame.data) as T;
  } catch (error) {
    throw new CaptureRuntimeProtocolError(`Capture Runtime returned invalid ${label} JSON.`, error);
  }
}
