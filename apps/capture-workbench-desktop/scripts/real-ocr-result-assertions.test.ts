import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertRealOcrResult,
  loadRealOcrExpectation,
  normalizeOcrText,
  type RealOcrUiResult,
} from './real-ocr-result-assertions.ts';

const expectation = {
  schemaVersion: 1 as const,
  sourceFileName: 'ocr_test_image.jpeg',
  rawTextIncludes: ['snow man', 'fluffy hat', 'hatband', 'igloo'],
};

function view(): RealOcrUiResult {
  const rawSegments: RealOcrUiResult['rawSegments'] = [
    {
      segmentId: 'segment-1',
      order: 0,
      locator: { kind: 'page', page: 1 },
      text: 'the snow man made a fluffy hat',
    },
    {
      segmentId: 'segment-2',
      order: 1,
      locator: { kind: 'page', page: 2 },
      text: 'the hatband is near the igloo',
    },
  ];
  const structuredBlocks = rawSegments.map((segment, index) => ({
    blockId: `block-${index + 1}`,
    order: index,
    sourceSegmentId: segment.segmentId,
    locator: segment.locator,
    sourceText: segment.text,
    targetText: segment.text,
  }));
  return {
    rawText: rawSegments.map((segment) => segment.text).join('\n'),
    rawSegments,
    structuredText: structuredBlocks.map((block) => block.targetText).join('\n'),
    structuredBlocks,
  };
}

test('normalizes OCR anchors across case, punctuation, and line breaks', () => {
  assert.equal(normalizeOcrText('Fluffy\nHAT!'), 'fluffy hat');
});

test('accepts visible OCR and structured projections with semantic anchors', () => {
  assert.deepEqual(
    assertRealOcrResult(view(), expectation, 'ocr_test_image.jpeg'),
    {
      rawSegmentCount: 2,
      structuredBlockCount: 2,
      expectedAnchorCount: 4,
      matchedAnchorCount: 4,
    },
  );
});

test('fails when the real OCR text misses an expected anchor', () => {
  const original = view();
  const rawSegments = original.rawSegments.map((segment, index) =>
    index === 1 ? { ...segment, text: 'the hatband is near the house' } : segment,
  );
  const candidate = {
    ...original,
    rawSegments,
    rawText: rawSegments.map((segment) => segment.text).join('\n'),
  } satisfies RealOcrUiResult;
  assert.throws(
    () => assertRealOcrResult(candidate, expectation, 'ocr_test_image.jpeg'),
    /did not contain the expected text anchor: igloo/u,
  );
});

test('fails when structured result detaches from raw OCR segments', () => {
  const original = view();
  const structuredBlocks = original.structuredBlocks.map((block, index) =>
    index === 1 ? { ...block, sourceText: 'wrong text' } : block,
  );
  const candidate = { ...original, structuredBlocks } satisfies RealOcrUiResult;
  assert.throws(
    () => assertRealOcrResult(candidate, expectation, 'ocr_test_image.jpeg'),
    /sourceText/u,
  );
});

test('fails when a visible result is empty', () => {
  const candidate = { ...view(), structuredText: '' } satisfies RealOcrUiResult;
  assert.throws(
    () => assertRealOcrResult(candidate, expectation, 'ocr_test_image.jpeg'),
    /visible structured result text/u,
  );
});

test('fails when OCR identities or locators are not one-to-one and valid', () => {
  const original = view();
  const duplicate = {
    ...original,
    rawSegments: original.rawSegments.map((segment) => ({ ...segment, segmentId: 'duplicate' })),
  } satisfies RealOcrUiResult;
  assert.throws(() => assertRealOcrResult(duplicate, expectation, 'ocr_test_image.jpeg'), /must be unique/u);

  const invalidLocator = {
    ...original,
    rawSegments: original.rawSegments.map((segment, index) => index === 0
      ? { ...segment, locator: { kind: 'page', page: Number.NaN } }
      : segment),
  } satisfies RealOcrUiResult;
  assert.throws(() => assertRealOcrResult(invalidLocator, expectation, 'ocr_test_image.jpeg'), /positive integer/u);
});

test('fails closed on a malformed OCR expectation manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'real-ocr-expectation-'));
  const sourcePath = join(root, 'input.jpeg');
  const expectationPath = join(root, 'input.jpeg.expected.json');
  await writeFile(sourcePath, 'fixture');
  await writeFile(expectationPath, '{ malformed', 'utf8');
  const previous = process.env.CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS;
  process.env.CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS = expectationPath;
  try {
    await assert.rejects(
      () => loadRealOcrExpectation(sourcePath),
      /not valid JSON/u,
    );
  } finally {
    if (previous === undefined) delete process.env.CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS;
    else process.env.CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS = previous;
  }
});
