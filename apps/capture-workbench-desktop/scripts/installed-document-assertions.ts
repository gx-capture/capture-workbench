import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export interface InstalledCaptureFixtureExpectation {
  readonly sourceKind: 'pdf' | 'image' | 'recording';
  readonly fileName: string;
  readonly mimeType: string;
  readonly sha256?: string;
  readonly bytes?: number;
  /** The source bytes of a small fixture; a generated large one gives `bytes` and `sha256` instead. */
  readonly buffer?: Buffer;
  readonly locatorKind: 'page' | 'time';
  readonly expectedSegments: number;
  readonly expectedTexts: readonly string[];
}

type ExpectedVisibleCaptureResult =
  | { readonly kind: 'page'; readonly text: string }
  | { readonly kind: 'time'; readonly lines: readonly string[] };

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
  // The stored source must be the file the smoke imported, byte for byte.
  const expectedSha256 = fixture.sha256
    ?? (fixture.buffer ? createHash('sha256').update(fixture.buffer).digest('hex') : undefined);
  assert.ok(expectedSha256, 'Installed fixture has no digest to compare with.');
  assert.equal(source['sha256'], expectedSha256);
  const expectedBytes = fixture.bytes ?? fixture.buffer?.length;
  assert.ok(expectedBytes, 'Installed fixture has no size to compare with.');
  assert.equal(source['bytes'], expectedBytes);

  assertEngine(
    capture['extractionEngine'],
    fixture.sourceKind === 'recording' ? 'speech-recognition' : 'text-recognition',
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
    assertLocator(entry['locator'], fixture.locatorKind, index, 'Raw segment locator');
    const text = assertNonEmptyString(entry['text'], 'Raw segment text', 100_000);
    assert.equal(text, fixture.expectedTexts[index]);
    segmentTexts.push(text);
  });

  const sourceText = assertNonEmptyString(capture['sourceText'], 'Raw capture sourceText', 500_000);
  assert.equal(sourceText, segmentTexts.join('\n'));
  assertDateTime(capture['createdAt'], 'Raw capture createdAt');
}

export interface ExpectedVisibleOcrPage {
  readonly page: number;
  readonly text: string;
}

/** Composes raw OCR page text the way the result review page composes it. */
export function expectedVisibleOcrPagesForRaw(
  raw: unknown,
): readonly ExpectedVisibleOcrPage[] {
  const capture = assertRecord(raw, 'Raw capture');
  const rawSegments = capture['segments'];
  assert.equal(Array.isArray(rawSegments), true, 'Raw capture segments must be an array.');

  const pages = new Map<number, { readonly order: number; readonly text: string }[]>();
  for (const rawSegment of rawSegments as readonly unknown[]) {
    const segment = assertRecord(rawSegment, 'Raw segment');
    const locator = assertRecord(segment['locator'], 'Raw segment locator');
    if (locator['kind'] !== 'page') continue;
    const text = typeof segment['text'] === 'string' ? segment['text'] : '';
    if (text.trim() === '') continue;
    const page = Number(locator['page']);
    assert.ok(Number.isInteger(page) && page >= 1, 'Raw segment page must be a positive integer.');
    const order = Number(segment['order']);
    const group = pages.get(page) ?? [];
    group.push({ order, text });
    pages.set(page, group);
  }
  const scope = capture['ocrPageScope'];
  if (scope !== null && typeof scope === 'object' && !Array.isArray(scope)) {
    const processed = (scope as { readonly processedPageNumbers?: unknown }).processedPageNumbers;
    if (Array.isArray(processed)) {
      for (const page of processed) {
        if (Number.isInteger(page) && Number(page) >= 1 && !pages.has(Number(page))) {
          pages.set(Number(page), []);
        }
      }
    }
  }
  const grouped = [...pages.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([page, segments]) => ({
      page,
      text: [...segments]
        .sort((left, right) => left.order - right.order)
        .map((segment) => segment.text)
        .join('\n'),
    }));
  assert.ok(grouped.length > 0, 'Raw capture had no page segments.');
  return grouped;
}

export function assertVisibleOcrPageText(
  visibleResult: unknown,
  expectedText: string,
  options: { readonly trim?: boolean } = {},
): string {
  const shouldTrim = options.trim ?? true;
  const normalizedVisible = typeof visibleResult === 'string'
    ? visibleResult.replace(/\r\n/gu, '\n')
    : '';
  const visibleText = shouldTrim ? normalizedVisible.trim() : normalizedVisible;
  const expectedNormalized = shouldTrim
    ? expectedText.trim()
    : expectedText.replace(/\r\n/gu, '\n');
  if (expectedText.trim().length > 0) {
    assert.ok(visibleText.trim().length > 0, 'Installed result preview was empty.');
  } else {
    assert.ok(typeof visibleResult === 'string', 'Installed result preview was missing.');
  }
  assert.equal(visibleText, expectedNormalized);
  return visibleText;
}

export function expectedVisibleResultForRaw(
  raw: unknown,
  fixture: Pick<InstalledCaptureFixtureExpectation, 'locatorKind'>,
): ExpectedVisibleCaptureResult {
  const capture = assertRecord(raw, 'Raw capture');
  const rawSegments = capture['segments'];
  assert.equal(Array.isArray(rawSegments), true, 'Raw capture segments must be an array.');

  if (fixture.locatorKind === 'page') {
    const pages = expectedVisibleOcrPagesForRaw(raw);
    const text = pages[0].text.trim();
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
  index: number,
  label: string,
): void {
  const locator = assertRecord(value, label);
  assert.equal(locator['kind'], expectedKind);
  if (expectedKind === 'page') {
    assertExactKeys(locator, ['kind', 'page'], label);
    assert.equal(locator['page'], index + 1);
    return;
  }
  assertExactKeys(locator, ['endMs', 'kind', 'startMs'], label);
  assert.equal(locator['startMs'], index * 1000);
  assert.equal(locator['endMs'], (index + 1) * 1000);
}

function assertDateTime(value: unknown, label: string): void {
  const text = assertNonEmptyString(value, label, 100);
  assert.match(
    text,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  );
  assert.equal(Number.isNaN(Date.parse(text)), false, `${label} must be a valid ISO timestamp.`);
}
