import assert from 'node:assert/strict';

export interface InstalledCaptureFixtureExpectation {
  readonly sourceKind: 'pdf' | 'image' | 'audio';
  readonly fileName: string;
  readonly mimeType: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly locatorKind: 'page' | 'time';
  readonly expectedSegments: number;
  readonly expectedTexts: readonly string[];
}

type ExpectedVisibleCaptureResult =
  | { readonly kind: 'page'; readonly text: string }
  | { readonly kind: 'time'; readonly lines: readonly string[] };

interface RawPageSegment {
  readonly order: number;
  readonly text: string;
  readonly locator: { readonly kind: 'page'; readonly page: number };
}

interface RawTimeSegment {
  readonly order: number;
  readonly text: string;
  readonly locator: { readonly kind: 'time'; readonly startMs: number; readonly endMs: number };
}

export function assertRawCaptureForFixture(
  raw: unknown,
  fixture: InstalledCaptureFixtureExpectation,
): void {
  const capture = assertRecord(raw, 'Raw capture');
  assertExactKeys(
    capture,
    [
      'createdAt',
      'diagnosticOnly',
      'extractionEngine',
      'schemaVersion',
      'segments',
      'source',
      'sourceText',
      'warnings',
    ],
    'Raw capture',
  );
  assert.equal(capture['schemaVersion'], '2');
  assert.equal(capture['diagnosticOnly'], true);

  const source = assertRecord(capture['source'], 'Raw capture source');
  assertExactKeys(source, ['bytes', 'fileName', 'mediaType', 'sha256'], 'Raw capture source');
  assert.equal(source['fileName'], fixture.fileName);
  assert.equal(source['mediaType'], fixture.mimeType);
  assert.match(String(source['sha256']), /^[0-9a-f]{64}$/u);
  if (fixture.sha256 !== undefined) assert.equal(source['sha256'], fixture.sha256);
  const bytes = source['bytes'];
  assert.equal(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0, true);
  if (fixture.bytes !== undefined) assert.equal(bytes, fixture.bytes);

  assertEngine(
    capture['extractionEngine'],
    fixture.sourceKind === 'audio' ? 'speech-recognition' : 'windowsml-ocr',
    'Extraction engine',
  );

  const warnings = capture['warnings'];
  assert.equal(Array.isArray(warnings), true, 'Raw capture warnings must be an array.');
  for (const warning of warnings as unknown[]) {
    assertNonEmptyString(warning, 'Raw capture warning', 500);
  }

  const segments = capture['segments'];
  assert.equal(Array.isArray(segments), true, 'Raw capture segments must be an array.');
  assert.equal((segments as unknown[]).length, fixture.expectedTexts.length);
  assert.equal((segments as unknown[]).length, fixture.expectedSegments);

  const segmentIds = new Set<string>();
  const segmentTexts: string[] = [];
  (segments as unknown[]).forEach((segment, index) => {
    const entry = assertRecord(segment, 'Raw segment');
    assertExactKeys(entry, ['locator', 'order', 'segmentId', 'text'], 'Raw segment');
    const segmentId = assertNonEmptyString(entry['segmentId'], 'Raw segment id', 100);
    assert.equal(segmentIds.has(segmentId), false, `Duplicate raw segment id: ${segmentId}`);
    segmentIds.add(segmentId);
    assert.equal(entry['order'], index);
    assertLocator(entry['locator'], fixture.locatorKind, 'Raw segment locator');
    const text = assertNonEmptyString(entry['text'], 'Raw segment text', 100_000);
    assert.equal(text, fixture.expectedTexts[index]);
    segmentTexts.push(text);
  });

  const sourceText = assertNonEmptyString(capture['sourceText'], 'Raw capture sourceText', 500_000);
  assert.equal(sourceText, segmentTexts.join('\n'));
  assertDateTime(capture['createdAt'], 'Raw capture createdAt');
}

export function expectedVisibleResultForRaw(
  raw: unknown,
  fixture: Pick<InstalledCaptureFixtureExpectation, 'locatorKind'>,
): ExpectedVisibleCaptureResult {
  const capture = assertRecord(raw, 'Raw capture');
  const rawSegments = capture['segments'];
  assert.equal(Array.isArray(rawSegments), true, 'Raw capture segments must be an array.');

  if (fixture.locatorKind === 'page') {
    const pageSegments = (rawSegments as RawPageSegment[])
      .filter((segment) => segment.locator.kind === 'page')
      .slice()
      .sort((left, right) => left.order - right.order);
    assert.ok(pageSegments.length > 0, 'Raw capture had no page segments.');
    const firstPage = Math.min(...pageSegments.map((segment) => segment.locator.page));
    const text = pageSegments
      .filter((segment) => segment.locator.page === firstPage)
      .map((segment) => segment.text)
      .join('\n')
      .trim();
    assert.ok(text.length > 0, 'Expected visible OCR page text was empty.');
    return { kind: 'page', text };
  }

  const timeSegments = (rawSegments as RawTimeSegment[])
    .filter((segment) => segment.locator.kind === 'time')
    .slice()
    .sort((left, right) => left.order - right.order);
  const lines = timeSegments.map((segment) => segment.text.trim());
  assert.ok(
    lines.length > 0 && lines.every((line) => line.length > 0),
    'Expected visible transcript lines were empty.',
  );
  return { kind: 'time', lines };
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    true,
    `${label} must be an object.`,
  );
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  assert.deepEqual(actual, [...expectedKeys].sort(), `${label} keys mismatch.`);
}

function assertNonEmptyString(value: unknown, label: string, maxLength: number): string {
  assert.equal(typeof value, 'string', `${label} must be a string.`);
  const text = value as string;
  assert.equal(text.trim().length > 0, true, `${label} must be non-empty.`);
  assert.equal(text.length <= maxLength, true, `${label} exceeds maximum length ${maxLength}.`);
  return text;
}

function assertEngine(value: unknown, expectedEngine: string, label: string): void {
  const engine = assertRecord(value, label);
  assertExactKeys(engine, ['device', 'digest', 'engine', 'model'], label);
  assert.equal(engine['engine'], expectedEngine);
  assertNonEmptyString(engine['model'], `${label} model`, 200);
  assert.match(String(engine['digest']), /^sha256:[0-9a-f]{64}$/u);
  assertNonEmptyString(engine['device'], `${label} device`, 100);
}

function assertLocator(
  value: unknown,
  expectedKind: 'page' | 'time',
  label: string,
): void {
  const locator = assertRecord(value, label);
  assert.equal(locator['kind'], expectedKind);
  if (expectedKind === 'page') {
    assertExactKeys(locator, ['kind', 'page'], label);
    const page = locator['page'];
    assert.equal(typeof page === 'number' && Number.isSafeInteger(page) && page >= 1, true);
    return;
  }
  assertExactKeys(locator, ['endMs', 'kind', 'startMs'], label);
  const startMs = locator['startMs'];
  const endMs = locator['endMs'];
  assert.equal(typeof startMs === 'number' && Number.isSafeInteger(startMs) && startMs >= 0, true);
  assert.equal(typeof endMs === 'number' && Number.isSafeInteger(endMs) && endMs > (startMs as number), true);
}

function assertDateTime(value: unknown, label: string): void {
  const text = assertNonEmptyString(value, label, 100);
  assert.equal(Number.isNaN(Date.parse(text)), false, `${label} must be a valid ISO timestamp.`);
}
