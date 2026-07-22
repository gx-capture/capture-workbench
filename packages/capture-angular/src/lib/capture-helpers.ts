import {
  CAPTURE_API_VERSION,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_RUNTIME_MAJOR,
  type CaptureDocumentV1,
  type CaptureLocatorV1,
  type CaptureOutputMode,
  type CaptureSourceKind,
  type CaptureStructuringCandidateV1,
  type CaptureStructuringMode,
  type RawCaptureV1,
  type RuntimeReadyV1,
} from './contracts';

const EXTENSION_KINDS: Readonly<Record<string, CaptureSourceKind>> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
};
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ENGINE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class CaptureCompatibilityError extends Error {
  readonly code = 'runtime_incompatible';

  constructor(message: string) {
    super(message);
    this.name = 'CaptureCompatibilityError';
  }
}

export function classifyCaptureFile(file: Pick<File, 'name'>): CaptureSourceKind | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_KINDS[extension] ?? null;
}

export function captureAccept(enabled: readonly CaptureSourceKind[]): string {
  const values: string[] = [];
  if (enabled.includes('pdf')) values.push('.pdf', 'application/pdf');
  if (enabled.includes('image')) {
    values.push('.png', '.jpg', '.jpeg', '.webp', 'image/png', 'image/jpeg', 'image/webp');
  }
  if (enabled.includes('audio')) {
    values.push('.mp3', '.wav', '.m4a', 'audio/mpeg', 'audio/wav', 'audio/mp4');
  }
  return values.join(',');
}

export function captureDocumentText(document: CaptureDocumentV1): string {
  return document.targetText.trim() || document.sourceText;
}

export function serializeCaptureDocument(
  document: CaptureDocumentV1,
  mode: CaptureOutputMode,
): string {
  return mode === 'json' ? JSON.stringify(document, null, 2) : captureDocumentText(document);
}

export function serializeRawCapture(raw: RawCaptureV1): string {
  return JSON.stringify(raw, null, 2);
}

export function assertCaptureRuntimeCompatible(
  ready: RuntimeReadyV1,
  compatibleRuntimeMajor = CAPTURE_RUNTIME_MAJOR,
  requiredStructuringMode?: CaptureStructuringMode,
): void {
  if (ready.service !== 'capture-runtime') {
    throw new CaptureCompatibilityError('The connected service is not Capture Runtime.');
  }
  const apiMajor = parseMajor(ready.apiVersion);
  const expectedApiMajor = parseMajor(CAPTURE_API_VERSION);
  if (apiMajor !== expectedApiMajor) {
    throw new CaptureCompatibilityError(
      `Capture API ${ready.apiVersion} is incompatible with client API ${CAPTURE_API_VERSION}.`,
    );
  }

  const runtimeMajor = parseMajor(ready.runtimeVersion);
  if (runtimeMajor !== compatibleRuntimeMajor) {
    throw new CaptureCompatibilityError(
      `Capture runtime ${ready.runtimeVersion} is incompatible with client runtime major ${compatibleRuntimeMajor}.`,
    );
  }

  if (ready.captureDocumentSchemaVersion !== CAPTURE_DOCUMENT_SCHEMA_VERSION) {
    throw new CaptureCompatibilityError(
      `Capture runtime does not support schema ${CAPTURE_DOCUMENT_SCHEMA_VERSION}.`,
    );
  }
  if (
    requiredStructuringMode &&
    !ready.capabilities.structuringModes.includes(requiredStructuringMode)
  ) {
    throw new CaptureCompatibilityError(
      `Capture runtime does not support ${requiredStructuringMode} structuring mode.`,
    );
  }
}

export function validateStructuringCandidate(
  candidate: CaptureStructuringCandidateV1,
  raw: RawCaptureV1,
): readonly string[] {
  const issues: string[] = [];
  if (candidate.schemaVersion !== CAPTURE_DOCUMENT_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${CAPTURE_DOCUMENT_SCHEMA_VERSION}`);
  }
  if (!candidate.sourceText.trim()) issues.push('sourceText must not be empty');
  if (!candidate.targetText.trim()) issues.push('targetText must not be empty');
  if (candidate.blocks.length === 0) issues.push('blocks must not be empty');
  if (!SHA256_HEX_PATTERN.test(candidate.source.sha256)) {
    issues.push('source.sha256 must be 64 lowercase hexadecimal characters');
  }
  if (!sameSource(candidate.source, raw.source)) {
    issues.push('source must exactly match raw capture evidence');
  }
  if (candidate.rawSegments.length !== raw.segments.length) {
    issues.push('rawSegments must preserve every raw capture segment');
  } else {
    for (const [index, segment] of candidate.rawSegments.entries()) {
      const rawSegment = raw.segments[index];
      if (
        !rawSegment ||
        segment.segmentId !== rawSegment.segmentId ||
        segment.order !== rawSegment.order ||
        segment.text !== rawSegment.text ||
        !locatorsEqual(segment.locator, rawSegment.locator)
      ) {
        issues.push(`rawSegments[${index}] must exactly preserve raw capture evidence`);
      }
    }
  }
  if (!ENGINE_DIGEST_PATTERN.test(candidate.extractionEngine.digest)) {
    issues.push('extractionEngine.digest must use sha256:<64 lowercase hex>');
  }
  if (!ENGINE_DIGEST_PATTERN.test(candidate.structuringEngine.digest)) {
    issues.push('structuringEngine.digest must use sha256:<64 lowercase hex>');
  }
  if (!sameEngine(candidate.extractionEngine, raw.extractionEngine)) {
    issues.push('extractionEngine must match raw capture provenance');
  }
  if (candidate.sourceText !== raw.sourceText) {
    issues.push('sourceText must exactly match raw capture evidence');
  }
  if (candidate.createdAt !== raw.createdAt) {
    issues.push('createdAt must exactly match raw capture evidence');
  }
  if (!raw.warnings.every((warning) => candidate.warnings.includes(warning))) {
    issues.push('warnings must preserve every raw capture warning');
  }
  if (!candidate.structuringEngine.engine.trim()) {
    issues.push('structuringEngine.engine must not be empty');
  }
  if (!candidate.structuringEngine.model.trim()) {
    issues.push('structuringEngine.model must not be empty');
  }
  if (!candidate.structuringEngine.digest.trim()) {
    issues.push('structuringEngine.digest must not be empty');
  }

  const rawSegmentIds = new Set<string>();
  for (const [index, segment] of raw.segments.entries()) {
    if (segment.order !== index) issues.push(`raw.segments[${index}].order must equal ${index}`);
    if (rawSegmentIds.has(segment.segmentId)) {
      issues.push(`raw.segments[${index}].segmentId must be unique`);
    }
    rawSegmentIds.add(segment.segmentId);
  }
  if (raw.sourceText !== raw.segments.map((segment) => segment.text).join('\n')) {
    issues.push('raw.sourceText must be the exact raw segment projection');
  }

  let previous: CaptureLocatorV1 | undefined;
  const blockIds = new Set<string>();
  for (const [index, block] of candidate.blocks.entries()) {
    if (block.order !== index) issues.push(`blocks[${index}].order must equal ${index}`);
    if (blockIds.has(block.blockId)) issues.push(`blocks[${index}].blockId must be unique`);
    blockIds.add(block.blockId);
    if (!block.sourceText.trim()) issues.push(`blocks[${index}].sourceText must not be empty`);
    if (!block.targetText.trim()) issues.push(`blocks[${index}].targetText must not be empty`);
    const expectedSegment = raw.segments[index];
    if (!expectedSegment || block.sourceSegmentId !== expectedSegment.segmentId) {
      issues.push(`blocks[${index}].sourceSegmentId must follow raw segment order`);
    } else {
      if (!locatorsEqual(block.locator, expectedSegment.locator)) {
        issues.push(`blocks[${index}].locator must equal its raw segment locator`);
      }
      if (block.sourceText !== expectedSegment.text) {
        issues.push(`blocks[${index}].sourceText must equal its raw segment text`);
      }
    }
    if (!isValidLocator(block.locator, raw)) {
      issues.push(`blocks[${index}].locator does not reference raw capture evidence`);
    }
    if (previous && compareLocators(previous, block.locator) > 0) {
      issues.push(`blocks[${index}].locator is out of source order`);
    }
    previous = block.locator;
  }
  if (candidate.blocks.length !== raw.segments.length) {
    issues.push('blocks must cover every raw segment exactly once');
  }
  const expectedTargetText = candidate.blocks.map((block) => block.targetText).join('\n');
  if (candidate.targetText !== expectedTargetText) {
    issues.push('targetText must be the exact block target projection');
  }
  return issues;
}

function parseMajor(version: string): number {
  const normalized = version.trim().replace(/^v/i, '');
  const major = Number.parseInt(normalized.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : -1;
}

function isValidLocator(locator: CaptureLocatorV1, raw: RawCaptureV1): boolean {
  if (locator.kind === 'page') {
    return (
      Number.isInteger(locator.page) &&
      locator.page > 0 &&
      (locator.boundingBox == null ||
        (locator.boundingBox.length === 4 && locator.boundingBox.every(Number.isFinite))) &&
      raw.segments.some(
        (segment) => segment.locator.kind === 'page' && segment.locator.page === locator.page,
      )
    );
  }
  return (
    Number.isInteger(locator.startMs) &&
    Number.isInteger(locator.endMs) &&
    locator.startMs >= 0 &&
    locator.endMs > locator.startMs &&
    raw.segments.some(
      (segment) =>
        segment.locator.kind === 'time' &&
        locator.startMs >= segment.locator.startMs &&
        locator.endMs <= segment.locator.endMs,
    )
  );
}

function compareLocators(left: CaptureLocatorV1, right: CaptureLocatorV1): number {
  if (left.kind !== right.kind) return left.kind === 'page' ? -1 : 1;
  return left.kind === 'page'
    ? left.page - (right as typeof left).page
    : left.startMs - (right as typeof left).startMs;
}

function locatorsEqual(left: CaptureLocatorV1, right: CaptureLocatorV1): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'time') {
    const rightTime = right as typeof left;
    return left.startMs === rightTime.startMs && left.endMs === rightTime.endMs;
  }
  const rightPage = right as typeof left;
  if (left.page !== rightPage.page) return false;
  if (left.boundingBox == null || rightPage.boundingBox == null) {
    return left.boundingBox == null && rightPage.boundingBox == null;
  }
  return left.boundingBox.every((value, index) => value === rightPage.boundingBox?.[index]);
}

function sameSource(
  left: CaptureDocumentV1['source'],
  right: RawCaptureV1['source'],
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.fileName === right.fileName &&
    left.mediaType === right.mediaType &&
    left.bytes === right.bytes
  );
}

function sameEngine(
  left: CaptureDocumentV1['extractionEngine'],
  right: RawCaptureV1['extractionEngine'],
): boolean {
  return (
    left.engine === right.engine &&
    left.model === right.model &&
    left.digest === right.digest &&
    left.device === right.device
  );
}
