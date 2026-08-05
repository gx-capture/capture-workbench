import type {
  CaptureDocumentV1,
  RawCaptureV1,
  RuntimeReadyV1,
} from './contracts';
import {
  assertCaptureRuntimeCompatible,
  CaptureCompatibilityError,
  validateStructuringCandidate,
} from './capture-helpers';
import {
  CAPTURE_DOCUMENT_V1_CONTRACT,
  CAPTURE_DOCUMENT_V1_JSON_SCHEMA,
  CAPTURE_DOCUMENT_V1_SCHEMA_SHA256,
} from './capture-document-schema';

const raw: RawCaptureV1 = {
  schemaVersion: '1',
  diagnosticOnly: true,
  source: {
    sha256: 'a'.repeat(64),
    fileName: 'fixture.pdf',
    mediaType: 'application/pdf',
    bytes: 7,
  },
  segments: [
    {
      segmentId: 's1',
      order: 0,
      locator: { kind: 'page', page: 1 },
      text: 'one',
    },
    {
      segmentId: 's2',
      order: 1,
      locator: { kind: 'page', page: 2 },
      text: 'two',
    },
  ],
  sourceText: 'one\ntwo',
  extractionEngine: {
    engine: 'windowsml',
    model: 'ocr-v1',
    digest: `sha256:${'b'.repeat(64)}`,
  },
  warnings: [],
  createdAt: '2026-07-20T00:00:00Z',
};

const candidate: CaptureDocumentV1 = {
  schemaVersion: '1',
  source: raw.source,
  rawSegments: raw.segments,
  blocks: raw.segments.map((segment) => ({
    blockId: `b${segment.order + 1}`,
    order: segment.order,
    sourceSegmentId: segment.segmentId,
    type: 'paragraph',
    locator: segment.locator,
    sourceText: segment.text,
    targetText: segment.text,
  })),
  sourceText: raw.sourceText,
  targetText: raw.sourceText,
  extractionEngine: raw.extractionEngine,
  structuringEngine: {
    engine: 'ollama',
    model: 'capture-v1',
    digest: `sha256:${'c'.repeat(64)}`,
  },
  warnings: [],
  createdAt: raw.createdAt,
  completedAt: '2026-07-20T00:00:01Z',
};

describe('capture helpers', () => {
  it('rejects runtime major and document schema mismatches', () => {
    const ready: RuntimeReadyV1 = {
      ready: true,
      service: 'capture-runtime',
      runtimeVersion: '1.0.0',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '2',
      capabilities: {
        captureKinds: ['pdf'],
        structuringModes: ['runtime'],
        supportsCancellation: true,
        supportsRawDiagnostics: true,
        maxUploadBytes: 100,
      },
    };

    expect(() => assertCaptureRuntimeCompatible(ready)).toThrow(
      CaptureCompatibilityError,
    );
  });

  it('rejects a service identity mismatch', () => {
    const ready = {
      ready: true,
      service: 'not-capture-runtime',
      runtimeVersion: '0.3.8',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      capabilities: {
        captureKinds: ['pdf'],
        structuringModes: ['runtime'],
        supportsCancellation: true,
        supportsRawDiagnostics: true,
        maxUploadBytes: 100,
      },
    } as unknown as RuntimeReadyV1;

    expect(() => assertCaptureRuntimeCompatible(ready)).toThrow(
      'not Capture Runtime',
    );
  });

  it('rejects a runtime process that does not expose the configured structuring mode', () => {
    const hostOnly: RuntimeReadyV1 = {
      ready: true,
      service: 'capture-runtime',
      runtimeVersion: '0.3.8',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      capabilities: {
        captureKinds: ['pdf', 'image', 'audio'],
        structuringModes: ['host'],
        supportsCancellation: true,
        supportsRawDiagnostics: true,
        maxUploadBytes: 100,
      },
    };

    expect(() =>
      assertCaptureRuntimeCompatible(hostOnly, 0, 'host'),
    ).not.toThrow();
    expect(() =>
      assertCaptureRuntimeCompatible(hostOnly, 0, 'runtime'),
    ).toThrow('does not support runtime structuring mode');
  });

  it('rejects a different runtime minor while the client is on 0.x', () => {
    const ready: RuntimeReadyV1 = {
      ready: true,
      service: 'capture-runtime',
      runtimeVersion: '0.2.9',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      capabilities: {
        captureKinds: ['pdf'],
        structuringModes: ['runtime'],
        supportsCancellation: true,
        supportsRawDiagnostics: true,
        maxUploadBytes: 100,
      },
    };

    expect(() => assertCaptureRuntimeCompatible(ready)).toThrow(
      'incompatible with client runtime minor 3',
    );
  });

  it('allows patch updates within the configured 0.x minor', () => {
    const ready: RuntimeReadyV1 = {
      ready: true,
      service: 'capture-runtime',
      runtimeVersion: '0.3.8',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      capabilities: {
        captureKinds: ['pdf'],
        structuringModes: ['runtime'],
        supportsCancellation: true,
        supportsRawDiagnostics: true,
        maxUploadBytes: 100,
      },
    };

    expect(() => assertCaptureRuntimeCompatible(ready)).not.toThrow();
  });

  it('exports a deeply immutable canonical document schema', () => {
    expect(CAPTURE_DOCUMENT_V1_CONTRACT.schemaVersion).toBe('1');
    expect(CAPTURE_DOCUMENT_V1_CONTRACT.schemaSha256).toBe(
      '2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2',
    );
    expect(CAPTURE_DOCUMENT_V1_SCHEMA_SHA256).toBe(
      '2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2',
    );
    expect(Object.isFrozen(CAPTURE_DOCUMENT_V1_JSON_SCHEMA)).toBe(true);
    expect(
      Object.isFrozen(
        CAPTURE_DOCUMENT_V1_JSON_SCHEMA.$defs.CaptureBlockV1.properties,
      ),
    ).toBe(true);
    expect(
      CAPTURE_DOCUMENT_V1_JSON_SCHEMA.$defs.CaptureEngineV1.properties.digest
        .pattern,
    ).toBe('^sha256:[0-9a-f]{64}$');
    expect(CAPTURE_DOCUMENT_V1_JSON_SCHEMA.$id).toBe(
      'https://github.com/gx-capture/capture-workbench/schema/capture-document-v1.schema.json',
    );
  });

  it('accepts a complete candidate that preserves evidence order', () => {
    expect(validateStructuringCandidate(candidate, raw)).toEqual([]);
  });

  it('rejects empty target text and reordered locators', () => {
    const first = candidate.blocks[0];
    const second = candidate.blocks[1];
    if (!first || !second) throw new Error('Expected two candidate blocks.');
    const invalid: CaptureDocumentV1 = {
      ...candidate,
      targetText: '',
      blocks: [
        { ...second, order: 0 },
        { ...first, order: 1 },
      ],
    };

    expect(validateStructuringCandidate(invalid, raw)).toEqual(
      expect.arrayContaining([
        'targetText must not be empty',
        'blocks[1].locator is out of source order',
      ]),
    );
  });

  it('rejects malformed SHA-256 provenance and zero-length time locators', () => {
    const timedRaw: RawCaptureV1 = {
      ...raw,
      segments: [
        {
          segmentId: 's1',
          order: 0,
          locator: { kind: 'time', startMs: 10, endMs: 10 },
          text: 'one',
        },
      ],
      sourceText: 'one',
    };
    const firstBlock = candidate.blocks[0];
    const timedSegment = timedRaw.segments[0];
    if (!firstBlock || !timedSegment)
      throw new Error('Expected timed fixture evidence.');
    const timedCandidate: CaptureDocumentV1 = {
      ...candidate,
      source: { ...candidate.source, sha256: 'ABC' },
      rawSegments: timedRaw.segments,
      blocks: [
        {
          ...firstBlock,
          locator: timedSegment.locator,
          sourceText: 'one',
          targetText: 'one',
        },
      ],
      sourceText: 'one',
      targetText: 'one',
      structuringEngine: {
        ...candidate.structuringEngine,
        digest: 'c'.repeat(64),
      },
    };

    expect(validateStructuringCandidate(timedCandidate, timedRaw)).toEqual(
      expect.arrayContaining([
        'source.sha256 must be 64 lowercase hexadecimal characters',
        'structuringEngine.digest must use sha256:<64 lowercase hex>',
        'blocks[0].locator does not reference raw capture evidence',
      ]),
    );
  });

  it('accepts an exact finite page bounding box', () => {
    const boxedLocator = {
      kind: 'page' as const,
      page: 1,
      boundingBox: [0, 1, 2, 3] as const,
    };
    const firstSegment = raw.segments[0];
    const firstBlock = candidate.blocks[0];
    if (!firstSegment || !firstBlock)
      throw new Error('Expected page fixture evidence.');
    const boxedRaw: RawCaptureV1 = {
      ...raw,
      segments: [{ ...firstSegment, locator: boxedLocator }],
      sourceText: 'one',
    };
    const boxedCandidate: CaptureDocumentV1 = {
      ...candidate,
      rawSegments: boxedRaw.segments,
      blocks: [{ ...firstBlock, locator: boxedLocator }],
      sourceText: 'one',
      targetText: 'one',
    };

    expect(validateStructuringCandidate(boxedCandidate, boxedRaw)).toEqual([]);
  });
});
