import { describe, expect, it } from 'vitest';

import {
  CAPTURE_BLOCK_BATCH_SCHEMA,
  StructuringValidationError,
  assembleStructuringDocument,
  planStructuringBatches,
  structureCapture,
  validateStructuringBatch,
  validateStructuringCandidate,
} from './index';

const completedAt = '2026-08-04T12:01:00.000Z';

function rawCapture() {
  const segments = [
    {
      segmentId: 'page-1',
      order: 0,
      locator: { kind: 'page' as const, page: 1 },
      text: 'A trusted source sentence.',
    },
    {
      segmentId: 'page-2',
      order: 1,
      locator: { kind: 'page' as const, page: 2 },
      text: 'A second source sentence.',
    },
  ];
  return {
    schemaVersion: '1' as const,
    diagnosticOnly: true as const,
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'sample.pdf',
      mediaType: 'application/pdf',
      bytes: 42,
    },
    segments,
    sourceText: segments.map((segment) => segment.text).join('\n'),
    extractionEngine: {
      engine: 'windowsml-ocr',
      model: 'capture-ocr-v1',
      digest: `sha256:${'b'.repeat(64)}`,
      device: 'igpu',
    },
    warnings: ['source warning'],
    createdAt: '2026-08-04T12:00:00.000Z',
  };
}

describe('brain-agnostic structuring SDK', () => {
  it('rebuilds trusted provenance from minimal LLM bytes', async () => {
    const prompts: Array<Record<string, unknown>> = [];
    const document = await structureCapture({
      raw: rawCapture(),
      structuringEngine: {
        engine: 'host-test',
        model: 'test-model',
        digest: `sha256:${'c'.repeat(64)}`,
        device: 'host',
      },
      completedAt,
      llmGenerate: async (prompt) => {
        prompts.push(prompt);
        return new TextEncoder().encode(
          JSON.stringify({
            blocks: prompt.rawSegments.map((segment) => ({
              sourceSegmentId: 'sourceSegmentId' in segment
                ? segment.sourceSegmentId
                : segment.segmentId,
              type: 'paragraph',
            })),
          }),
        );
      },
    });

    expect(document.source).toEqual(rawCapture().source);
    expect(document.rawSegments).toEqual(rawCapture().segments);
    expect(document.blocks[0]).toEqual({
      blockId: 'block-page-1',
      order: 0,
      type: 'paragraph',
      sourceSegmentId: 'page-1',
      locator: { kind: 'page', page: 1 },
      sourceText: 'A trusted source sentence.',
      targetText: 'A trusted source sentence.',
    });
    expect(prompts[0]).toHaveProperty('rawSegments');
  });

  it('rejects a full block echo at the LLM seam', () => {
    expect(() =>
      validateStructuringBatch(
        new TextEncoder().encode(
          JSON.stringify({
            blocks: [
              {
                sourceSegmentId: 'page-1',
                type: 'paragraph',
                blockId: 'forged',
              },
            ],
          }),
        ),
        rawCapture().segments,
        { targetLanguage: 'zh-TW' },
      ),
    ).toThrow(StructuringValidationError);
  });

  it('rejects schema-invalid document fields before provenance comparison', () => {
    const raw = rawCapture();
    const valid = assembleStructuringDocument(
      raw,
      [
        {
          blockId: 'block-page-1',
          order: 0,
          type: 'paragraph',
          sourceSegmentId: 'page-1',
          locator: raw.segments[0].locator,
          sourceText: raw.segments[0].text,
          targetText: raw.segments[0].text,
        },
        {
          blockId: 'block-page-2',
          order: 1,
          type: 'paragraph',
          sourceSegmentId: 'page-2',
          locator: raw.segments[1].locator,
          sourceText: raw.segments[1].text,
          targetText: raw.segments[1].text,
        },
      ],
      {
        engineIdentity: raw.extractionEngine,
        completedAt,
      },
    );
    const invalid = structuredClone(valid) as unknown as {
      source: { sha256: string };
    };
    invalid.source.sha256 = 'not-a-sha256';

    expect(() => validateStructuringCandidate(invalid, raw)).toThrow(
      StructuringValidationError,
    );
  });

  it('compares provenance objects independently of property order', () => {
    const raw = rawCapture();
    const valid = assembleStructuringDocument(
      raw,
      raw.segments.map((segment, index) => ({
        blockId: `block-${segment.segmentId}`,
        order: index,
        type: 'paragraph' as const,
        sourceSegmentId: segment.segmentId,
        locator: segment.locator,
        sourceText: segment.text,
        targetText: segment.text,
      })),
      { engineIdentity: raw.extractionEngine, completedAt },
    );
    const reorder = (value: object) =>
      Object.fromEntries(Object.entries(value).reverse());
    const reordered = {
      ...valid,
      source: reorder(valid.source),
      rawSegments: valid.rawSegments.map((segment) => reorder(segment)),
      blocks: valid.blocks.map((block) => ({
        ...block,
        locator: reorder(block.locator),
      })),
      extractionEngine: reorder(valid.extractionEngine),
      structuringEngine: reorder(valid.structuringEngine),
    };

    expect(validateStructuringCandidate(reordered, raw)).toEqual(reordered);
  });

  it('uses the canonical schema by default and accepts an explicit host schema', async () => {
    const schemas: unknown[] = [];
    await structureCapture({
      raw: rawCapture(),
      targetLanguage: 'zh-TW',
      structuringEngine: rawCapture().extractionEngine,
      completedAt,
      llmGenerate: async (prompt, schema) => {
        schemas.push(schema);
        return new TextEncoder().encode(
          JSON.stringify({
            blocks: prompt.rawSegments.map((segment) => ({
              sourceSegmentId: 'sourceSegmentId' in segment
                ? segment.sourceSegmentId
                : segment.segmentId,
              type: 'paragraph',
              targetText: 'translated',
            })),
          }),
        );
      },
    });

    expect(schemas[0]).toBe(CAPTURE_BLOCK_BATCH_SCHEMA);

    const hostSchema = { title: 'host-schema', type: 'object' } as const;
    schemas.length = 0;
    await structureCapture({
      raw: rawCapture(),
      targetLanguage: 'zh-TW',
      schema: hostSchema,
      structuringEngine: rawCapture().extractionEngine,
      completedAt,
      llmGenerate: async (prompt, schema) => {
        schemas.push(schema);
        return new TextEncoder().encode(
          JSON.stringify({
            blocks: prompt.rawSegments.map((segment) => ({
              sourceSegmentId: 'sourceSegmentId' in segment
                ? segment.sourceSegmentId
                : segment.segmentId,
              type: 'paragraph',
              targetText: 'translated',
            })),
          }),
        );
      },
    });

    expect(schemas[0]).toBe(hostSchema);
  });

  it('rejects count, order, and mode-specific semantic violations', () => {
    const segments = rawCapture().segments;
    expect(() => validateStructuringBatch(
      JSON.stringify({ blocks: [] }),
      segments,
    )).toThrow(StructuringValidationError);
    expect(() => validateStructuringBatch(
      JSON.stringify({
        blocks: [
          { sourceSegmentId: 'page-2', type: 'paragraph' },
          { sourceSegmentId: 'page-1', type: 'paragraph' },
        ],
      }),
      segments,
    )).toThrow(StructuringValidationError);
    expect(() => validateStructuringBatch(
      JSON.stringify({
        blocks: [
          { sourceSegmentId: 'page-1', type: 'paragraph', targetText: 'echo' },
          { sourceSegmentId: 'page-2', type: 'paragraph', targetText: 'echo' },
        ],
      }),
      segments,
    )).toThrow(StructuringValidationError);
    expect(() => validateStructuringBatch(
      JSON.stringify({
        blocks: [
          { sourceSegmentId: 'page-1', type: 'paragraph' },
          { sourceSegmentId: 'page-2', type: 'paragraph' },
        ],
      }),
      segments,
      { targetLanguage: 'zh-TW' },
    )).toThrow(StructuringValidationError);
  });

  it('rejects an oversized segment before issuing a host request', () => {
    const segment = {
      ...rawCapture().segments[0],
      text: 'x'.repeat(2_000_000),
    };

    expect(() => planStructuringBatches([segment], { targetLanguage: 'zh-TW' })).toThrow(
      StructuringValidationError,
    );
  });
});
