import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export interface RealOcrExpectation {
  readonly schemaVersion: 1;
  readonly sourceFileName?: string;
  readonly rawTextIncludes: readonly string[];
}

export interface RealOcrUiSegment {
  readonly segmentId: string;
  readonly order: number;
  readonly locator: RealOcrLocator;
  readonly text: string;
}

export type RealOcrLocator =
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'time'; readonly startMs: number; readonly endMs: number };

export interface RealOcrUiBlock {
  readonly blockId: string;
  readonly order: number;
  readonly sourceSegmentId: string;
  readonly locator: RealOcrLocator;
  readonly sourceText: string;
  readonly targetText: string;
}

export interface RealOcrUiResult {
  readonly rawText: string;
  readonly rawSegments: readonly RealOcrUiSegment[];
  readonly structuredText: string;
  readonly structuredBlocks: readonly RealOcrUiBlock[];
}

export interface RealOcrVerification {
  readonly rawSegmentCount: number;
  readonly structuredBlockCount: number;
  readonly expectedAnchorCount: number;
  readonly matchedAnchorCount: number;
}

export async function loadRealOcrExpectation(sourcePath: string): Promise<RealOcrExpectation> {
  const configuredPath = process.env.CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS?.trim();
  const expectationPath = resolve(configuredPath || `${sourcePath}.expected.json`);
  const metadata = await stat(expectationPath).catch(() => undefined);
  if (!metadata?.isFile()) {
    throw new Error(
      `Real OCR acceptance requires an expectation manifest: ${expectationPath}. ` +
      'Set CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS or place <input>.expected.json beside the input.',
    );
  }
  const contents = await readFile(expectationPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Real OCR expectation manifest is not valid JSON: ${expectationPath}.`,
      { cause: error },
    );
  }
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'Real OCR expectation manifest must be an object.');
  const record = parsed as Record<string, unknown>;
  assert.equal(record.schemaVersion, 1, 'Real OCR expectation schemaVersion');
  if (record.sourceFileName !== undefined) {
    assertNonEmptyString(record.sourceFileName, 'Real OCR expectation sourceFileName');
    assert.equal(
      basename(sourcePath).toLowerCase(),
      String(record.sourceFileName).toLowerCase(),
      'Real OCR expectation sourceFileName must identify the selected input.',
    );
  }
  assert.ok(Array.isArray(record.rawTextIncludes), 'Real OCR expectation rawTextIncludes must be an array.');
  const rawTextIncludes = record.rawTextIncludes.map((value, index) => {
    assertNonEmptyString(value, `Real OCR expectation rawTextIncludes[${index}]`);
    const normalized = normalizeOcrText(value);
    assert.ok(normalized, `Real OCR expectation rawTextIncludes[${index}] must contain letters or digits.`);
    return normalized;
  });
  assert.ok(rawTextIncludes.length > 0, 'Real OCR expectation must contain at least one text anchor.');
  assert.equal(
    new Set(rawTextIncludes).size,
    rawTextIncludes.length,
    'Real OCR expectation anchors must be unique after normalization.',
  );
  return {
    schemaVersion: 1,
    sourceFileName: record.sourceFileName === undefined ? undefined : String(record.sourceFileName),
    rawTextIncludes,
  };
}

export function normalizeOcrText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

export function assertRealOcrResult(
  view: RealOcrUiResult,
  expectation: RealOcrExpectation,
  inputFileName: string,
): RealOcrVerification {
  assertNonEmptyString(view.rawText, 'visible OCR raw text');
  assert.ok(view.rawSegments.length > 0, 'visible OCR result must contain at least one segment.');
  for (const [index, segment] of view.rawSegments.entries()) {
    assertNonEmptyString(segment.segmentId, `visible OCR segments[${index}] segmentId`);
    assert.ok(
      view.rawSegments.findIndex((candidate) => candidate.segmentId === segment.segmentId) === index,
      `visible OCR segments[${index}] segmentId must be unique.`,
    );
    assert.equal(segment.order, index, `visible OCR segments[${index}] order`);
    assertNonEmptyString(segment.text, `visible OCR segments[${index}] text`);
    assertRealOcrLocator(segment.locator, `visible OCR segments[${index}] locator`);
  }
  assert.equal(
    view.rawText,
    view.rawSegments.map((segment) => segment.text).join('\n'),
    'visible OCR text must be the exact segment projection.',
  );

  const normalizedRawText = normalizeOcrText(view.rawText);
  let anchorCursor = 0;
  for (const anchor of expectation.rawTextIncludes) {
    const anchorPosition = normalizedRawText.indexOf(anchor, anchorCursor);
    assert.ok(
      anchorPosition >= 0,
      `OCR result for ${inputFileName} did not contain the expected text anchor: ${anchor}.`,
    );
    anchorCursor = anchorPosition + anchor.length;
  }
  const matchedAnchorCount = expectation.rawTextIncludes.length;

  assertNonEmptyString(view.structuredText, 'visible structured result text');
  assert.equal(
    view.structuredBlocks.length,
    view.rawSegments.length,
    'structured result must contain one block per OCR segment.',
  );
  for (const [index, block] of view.structuredBlocks.entries()) {
    const segment = view.rawSegments[index];
    assertNonEmptyString(block.blockId, `visible structured blocks[${index}] blockId`);
    assert.ok(
      view.structuredBlocks.findIndex((candidate) => candidate.blockId === block.blockId) === index,
      `visible structured blocks[${index}] blockId must be unique.`,
    );
    assert.equal(block.order, index, `visible structured blocks[${index}] order`);
    assert.equal(block.sourceSegmentId, segment.segmentId, `visible structured blocks[${index}] sourceSegmentId`);
    assert.deepEqual(block.locator, segment.locator, `visible structured blocks[${index}] locator`);
    assert.equal(block.sourceText, segment.text, `visible structured blocks[${index}] sourceText`);
    assertNonEmptyString(block.targetText, `visible structured blocks[${index}] targetText`);
  }
  assert.equal(
    view.structuredText,
    view.structuredBlocks.map((block) => block.targetText).join('\n'),
    'visible structured result must be the exact block target projection.',
  );

  return {
    rawSegmentCount: view.rawSegments.length,
    structuredBlockCount: view.structuredBlocks.length,
    expectedAnchorCount: expectation.rawTextIncludes.length,
    matchedAnchorCount,
  };
}

function assertRealOcrLocator(value: unknown, label: string): asserts value is RealOcrLocator {
  assert.ok(value !== null && typeof value === 'object', `${label} must be an object.`);
  const locator = value as Record<string, unknown>;
  if (locator.kind === 'page') {
    assert.ok(Number.isInteger(locator.page) && Number(locator.page) >= 1, `${label}.page must be a positive integer.`);
    assert.equal(Object.keys(locator).sort().join(','), 'kind,page', `${label} has unexpected fields.`);
    return;
  }
  if (locator.kind === 'time') {
    assert.ok(Number.isFinite(locator.startMs) && Number(locator.startMs) >= 0, `${label}.startMs must be non-negative.`);
    assert.ok(Number.isFinite(locator.endMs) && Number(locator.endMs) > Number(locator.startMs), `${label}.endMs must be after startMs.`);
    assert.equal(Object.keys(locator).sort().join(','), 'endMs,kind,startMs', `${label} has unexpected fields.`);
    return;
  }
  assert.fail(`${label}.kind must be page or time.`);
}

function assertNonEmptyString(value: unknown, label: string): void {
  assert.equal(typeof value, 'string', `${label} must be a string.`);
  assert.ok(String(value).trim(), `${label} must not be empty.`);
}
