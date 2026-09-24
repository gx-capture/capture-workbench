import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertDurableOcrSegmentsEqual,
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

type MutableDurableOcrSegment = Record<string, unknown>;

function cloneDurableOcrSegments(): MutableDurableOcrSegment[] {
  return structuredClone(view().rawSegments) as unknown as MutableDurableOcrSegment[];
}

function cloneDurableOcrSegmentsWithNullablePageBoxes(): MutableDurableOcrSegment[] {
  return cloneDurableOcrSegments().map((segment) => ({
    ...segment,
    locator: {
      ...(segment.locator as Record<string, unknown>),
      boundingBox: null,
    },
  }));
}

function durableLocator(segment: MutableDurableOcrSegment): Record<string, unknown> {
  return segment.locator as Record<string, unknown>;
}

test('normalizes OCR anchors across case, punctuation, and line breaks', () => {
  assert.equal(normalizeOcrText('Fluffy\nHAT!'), 'fluffy hat');
});

test('records the legacy direct deep-equality red for a durable nullable page box', () => {
  assert.throws(
    () => assert.deepEqual(cloneDurableOcrSegmentsWithNullablePageBoxes(), view().rawSegments),
    /boundingBox/u,
  );
});

test('accepts absent and nullable page bounding boxes without mutating durable data', () => {
  const expected = view().rawSegments;
  const absent = cloneDurableOcrSegments();
  const nullable = cloneDurableOcrSegmentsWithNullablePageBoxes();
  const nullableBefore = structuredClone(nullable);

  assert.doesNotThrow(() => assertDurableOcrSegmentsEqual(absent, expected));
  assert.doesNotThrow(() => assertDurableOcrSegmentsEqual(nullable, expected));
  assert.deepEqual(nullable, nullableBefore);
});

test('rejects durable OCR segment, page locator, and bounding-box drift', () => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (segments: MutableDurableOcrSegment[]) => void;
  }[] = [
    {
      name: 'segment array length drift',
      mutate: (segments) => { segments.pop(); },
    },
    {
      name: 'segment array order drift',
      mutate: (segments) => { segments.reverse(); },
    },
    {
      name: 'non-null bounding box tuple',
      mutate: (segments) => { durableLocator(segments[0]).boundingBox = [0, 0, 100, 100]; },
    },
    {
      name: 'malformed bounding box tuple',
      mutate: (segments) => { durableLocator(segments[0]).boundingBox = [0, 0, 100]; },
    },
    {
      name: 'NaN bounding box tuple',
      mutate: (segments) => { durableLocator(segments[0]).boundingBox = [Number.NaN, 0, 100, 100]; },
    },
    {
      name: 'page drift',
      mutate: (segments) => { durableLocator(segments[0]).page = 2; },
    },
    {
      name: 'locator kind drift',
      mutate: (segments) => {
        segments[0].locator = { kind: 'time', startMs: 0, endMs: 1_000 };
      },
    },
    {
      name: 'segment id drift',
      mutate: (segments) => { segments[0].segmentId = 'segment-other'; },
    },
    {
      name: 'segment order drift',
      mutate: (segments) => { segments[0].order = 1; },
    },
    {
      name: 'segment text drift',
      mutate: (segments) => { segments[0].text = 'different text'; },
    },
    {
      name: 'unknown locator field',
      mutate: (segments) => { durableLocator(segments[0]).unexpected = true; },
    },
    {
      name: 'unknown segment field',
      mutate: (segments) => { segments[0].unexpected = true; },
    },
  ];

  for (const { name, mutate } of cases) {
    const actual = cloneDurableOcrSegments();
    mutate(actual);
    assert.throws(
      () => assertDurableOcrSegmentsEqual(actual, view().rawSegments),
      /durable raw OCR segments must equal the public UI projection/u,
      name,
    );
  }
});

test('rejects a nullable bounding box on a time locator', () => {
  const expected = [{
    segmentId: 'segment-time',
    order: 0,
    locator: { kind: 'time' as const, startMs: 0, endMs: 1_000 },
    text: 'time segment',
  }];
  const actual = [{
    ...expected[0],
    locator: { ...expected[0].locator, boundingBox: null },
  }];

  assert.throws(
    () => assertDurableOcrSegmentsEqual(actual, expected),
    /durable raw OCR segments must equal the public UI projection/u,
  );
});

test('requires exact time locator values', () => {
  const expected = [{
    segmentId: 'segment-time',
    order: 0,
    locator: { kind: 'time' as const, startMs: 0, endMs: 1_000 },
    text: 'time segment',
  }];
  const cases = [
    { name: 'startMs drift', field: 'startMs', value: 1 },
    { name: 'endMs drift', field: 'endMs', value: 1_001 },
  ] as const;

  assert.doesNotThrow(() => assertDurableOcrSegmentsEqual(structuredClone(expected), expected));
  for (const { name, field, value } of cases) {
    const actual = structuredClone(expected) as unknown as MutableDurableOcrSegment[];
    durableLocator(actual[0])[field] = value;
    assert.throws(
      () => assertDurableOcrSegmentsEqual(actual, expected),
      /durable raw OCR segments must equal the public UI projection/u,
      name,
    );
  }
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
