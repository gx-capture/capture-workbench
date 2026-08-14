import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CAPTURE_BLOCK_TYPES } from './constants/installed.ts';

const captureBlockTypes = CAPTURE_BLOCK_TYPES;

export function assertCaptureDocumentForFixture(document, fixture) {
  assertRecord(document, 'CaptureDocument');
  assertExactKeys(
    document,
    [
      'blocks',
      'completedAt',
      'createdAt',
      'extractionEngine',
      'rawSegments',
      'schemaVersion',
      'source',
      'sourceText',
      'structuringEngine',
      'targetText',
      'warnings',
    ],
    'CaptureDocument',
  );
  assert.equal(document.schemaVersion, '2');

  assertRecord(document.source, 'CaptureDocument.source');
  assertExactKeys(
    document.source,
    ['bytes', 'fileName', 'mediaType', 'sha256'],
    'CaptureDocument.source',
  );
  assert.equal(document.source.fileName, fixture.fileName);
  assert.equal(document.source.mediaType, fixture.mimeType);
  assert.equal(document.source.bytes, fixture.buffer.length);
  assert.equal(
    document.source.sha256,
    createHash('sha256').update(fixture.buffer).digest('hex'),
  );
  assert.match(document.source.sha256, /^[0-9a-f]{64}$/u);

  assertEngine(document.extractionEngine, 'CaptureDocument.extractionEngine');
  assertEngine(
    document.structuringEngine,
    'CaptureDocument.structuringEngine',
  );
  assert.ok(Array.isArray(document.warnings));
  assert.ok(
    document.warnings.every(
      (warning) => typeof warning === 'string' && warning.length <= 500,
    ),
  );

  assert.ok(Array.isArray(document.rawSegments));
  assert.equal(document.rawSegments.length, fixture.expectedSegments);
  const segmentIds = new Set();
  document.rawSegments.forEach((segment, index) => {
    assertRecord(segment, `rawSegments[${index}]`);
    assertExactKeys(
      segment,
      ['locator', 'order', 'segmentId', 'text'],
      `rawSegments[${index}]`,
    );
    assertNonEmptyString(segment.segmentId, `rawSegments[${index}].segmentId`);
    assert.equal(segmentIds.has(segment.segmentId), false);
    segmentIds.add(segment.segmentId);
    assert.equal(segment.order, index);
    assert.equal(segment.text, fixture.expectedTexts[index]);
    assertLocator(
      segment.locator,
      fixture,
      index,
      `rawSegments[${index}].locator`,
    );
  });
  assert.equal(
    document.sourceText,
    document.rawSegments.map((segment) => segment.text).join('\n'),
  );
  assertNonEmptyString(document.sourceText, 'CaptureDocument.sourceText');

  assert.ok(Array.isArray(document.blocks));
  assert.equal(document.blocks.length, fixture.expectedSegments);
  const blockIds = new Set();
  document.blocks.forEach((block, index) => {
    const segment = document.rawSegments[index];
    assertRecord(block, `blocks[${index}]`);
    assertExactKeys(
      block,
      [
        'blockId',
        'locator',
        'order',
        'sourceSegmentId',
        'sourceText',
        'targetText',
        'type',
      ],
      `blocks[${index}]`,
    );
    assertNonEmptyString(block.blockId, `blocks[${index}].blockId`);
    assert.equal(blockIds.has(block.blockId), false);
    blockIds.add(block.blockId);
    assert.equal(block.order, index);
    assert.equal(block.sourceSegmentId, segment.segmentId);
    assert.equal(captureBlockTypes.has(block.type), true);
    assert.equal(
      block.type,
      fixture.locatorKind === 'time' ? 'transcript' : 'paragraph',
    );
    assert.deepEqual(block.locator, segment.locator);
    assert.equal(block.sourceText, segment.text);
    assertNonEmptyString(block.targetText, `blocks[${index}].targetText`);
  });
  assert.equal(
    document.targetText,
    document.blocks.map((block) => block.targetText).join('\n'),
  );
  assertNonEmptyString(document.targetText, 'CaptureDocument.targetText');

  const createdAt = assertDateTime(
    document.createdAt,
    'CaptureDocument.createdAt',
  );
  const completedAt = assertDateTime(
    document.completedAt,
    'CaptureDocument.completedAt',
  );
  assert.ok(completedAt >= createdAt, 'completedAt must not precede createdAt');
}

function assertRecord(value, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assertExactKeys(value, keys, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} keys`,
  );
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function assertEngine(engine, label) {
  assertRecord(engine, label);
  const keys = Object.keys(engine);
  assert.ok(
    keys.every((key) => ['device', 'digest', 'engine', 'model'].includes(key)),
  );
  assert.ok(['digest', 'engine', 'model'].every((key) => keys.includes(key)));
  assertNonEmptyString(engine.engine, `${label}.engine`);
  assertNonEmptyString(engine.model, `${label}.model`);
  assert.match(engine.digest, /^sha256:[0-9a-f]{64}$/u);
  if (engine.device !== undefined && engine.device !== null) {
    assertNonEmptyString(engine.device, `${label}.device`);
  }
}

function assertLocator(locator, fixture, index, label) {
  assertRecord(locator, label);
  assert.equal(locator.kind, fixture.locatorKind);
  if (fixture.locatorKind === 'page') {
    assert.ok(
      Object.keys(locator).every((key) =>
        ['boundingBox', 'kind', 'page'].includes(key),
      ),
      `${label} has unexpected keys`,
    );
    assert.equal(locator.page, index + 1);
    if (locator.boundingBox !== undefined && locator.boundingBox !== null) {
      assert.equal(locator.boundingBox.length, 4);
      assert.ok(locator.boundingBox.every(Number.isFinite));
    }
    return;
  }
  assertExactKeys(locator, ['endMs', 'kind', 'startMs'], label);
  assert.equal(locator.startMs, index * 1000);
  assert.equal(locator.endMs, (index + 1) * 1000);
  assert.ok(locator.startMs >= 0 && locator.endMs > locator.startMs);
}

function assertDateTime(value, label) {
  assertNonEmptyString(value, label);
  assert.match(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  );
  const timestamp = Date.parse(value);
  assert.ok(Number.isFinite(timestamp), `${label} must be a valid date-time`);
  return timestamp;
}
