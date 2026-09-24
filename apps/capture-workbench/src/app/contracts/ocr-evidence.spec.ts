import type {
  CaptureOcrProjection,
  OcrBox,
  OcrPageProjection,
  OcrProvenance,
} from '@gx-capture/capture-runtime-client';
import { firstValueFrom } from 'rxjs';
import { buildOcrEvidence as buildOcrEvidence$ } from './ocr-evidence';
// The native mirror includes this repository-level golden fixture too; keep one exact cross-language artifact.
// eslint-disable-next-line @nx/enforce-module-boundaries
import goldenEvidence from '../../../../../test-fixtures/ocr-evidence-v1-golden.json';

describe('buildOcrEvidence', () => {
  it('exposes a cold Observable contract for evidence construction', () => {
    const evidence$ = buildOcrEvidence$({
      projection: projection(),
      expected: expectedIdentity(),
    });

    expect(typeof evidence$.subscribe).toBe('function');
  });

  it('projects a recognized OCR page into privacy-safe evidence', async () => {
    const evidence = await buildOcrEvidence({
      projection: projection(),
      expected: expectedIdentity(),
    });

    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.captureId).toBe('capture-1');
    expect(evidence.sourceSha256).toBe('a'.repeat(64));
    expect(evidence.pageCount).toBe(1);
    expect(evidence.pages[0]).toMatchObject({
      page: 1,
      status: 'recognized',
      raster: { width: 1200, height: 800 },
      normalizedCharCount: 11,
      boxCount: 1,
      confidence: 0.875,
      confidenceSummary: {
        scoreState: 'numeric',
        numericCount: 1,
        min: 0.875,
        max: 0.875,
        mean: 0.875,
      },
    });
    expect(evidence.summary).toMatchObject({
      normalizedCharCount: 11,
      boxCount: 1,
      confidenceSummary: {
        scoreState: 'numeric',
        numericCount: 1,
        min: 0.875,
        max: 0.875,
        mean: 0.875,
      },
    });
    expect(evidence.provenance).toMatchObject({
      runtimeVersion: '0.4.2',
      contractSha256: 'c'.repeat(64),
      engine: 'windowsml-ocr',
      model: 'ppocrv6-traditional-multilingual',
      modelDigest: `sha256:${'d'.repeat(64)}`,
      device: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
      workerSha256: 'f'.repeat(64),
    });

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('敏感 raw text');
    expect(serialized).not.toContain('box-secret');
    expect(serialized).not.toContain('"x"');
    expect(serialized).not.toContain('C:\\\\private');
    expect(serialized).not.toContain('Bearer');
    expect(evidence.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['captureId', { captureId: 'other-capture' }],
    ['sourceSha256', { sourceSha256: 'b'.repeat(64) }],
    ['runtimeVersion', { runtimeVersion: '0.4.1' }],
    ['contractSha256', { contractSha256: 'b'.repeat(64) }],
  ])('fails closed when expected %s identity does not match', async (_field, change) => {
    await expect(buildOcrEvidence({
      projection: projection(),
      expected: { ...expectedIdentity(), ...change },
    })).rejects.toThrow(/Invalid OCR evidence/u);
  });

  it('requires pages to be exactly ordered 1..N', async () => {
    const outOfOrder = projectionWithPage({ page: 2 });
    await expect(buildOcrEvidence({ projection: outOfOrder, expected: expectedIdentity() }))
      .rejects.toThrow(/ordering/u);

    const countMismatch = { ...projection(), pageCount: 2 };
    await expect(buildOcrEvidence({ projection: countMismatch, expected: expectedIdentity() }))
      .rejects.toThrow(/pages\/pageCount/u);
  });

  it('preserves empty-page semantics without inventing text or confidence', async () => {
    const empty = emptyPage();
    const evidence = await buildOcrEvidence({
      projection: failedProjection(empty, resolvedProvenance()),
      expected: expectedIdentity('failed'),
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.pages[0]).toMatchObject({
      status: 'empty',
      normalizedCharCount: 0,
      boxCount: 0,
      confidence: null,
      confidenceSummary: {
        scoreState: 'none',
        numericCount: 0,
        min: null,
        max: null,
        mean: null,
      },
    });
    expect(evidence.failure).toMatchObject({ code: 'ocr_failed' });
  });

  it('retains a typed failed-page projection while sanitizing its message', async () => {
    const failed = failedPage();
    const evidence = await buildOcrEvidence({
      projection: failedProjection(failed, unavailableProvenance()),
      expected: expectedIdentity('failed'),
    });

    expect(evidence.pages[0]).toMatchObject({
      status: 'failed',
      normalizedCharCount: 0,
      boxCount: 0,
      confidence: null,
      failure: {
        code: 'ocr_worker_failed',
        message: 'OCR failure: ocr_worker_failed.',
      },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('C:\\\\private\\token.txt');
    expect(serialized).not.toContain('Bearer top-secret');
  });

  it('normalizes NFKC and Unicode whitespace before counting code points', async () => {
    const candidate = projectionWithPage({ text: 'ＡＢＣ\u00a0\r\n\ud83d\ude00' });
    const evidence = await buildOcrEvidence({ projection: candidate, expected: expectedIdentity() });
    expect(evidence.pages[0].normalizedCharCount).toBe(5);
  });

  it('reports none for a recognized page with no numeric box scores and uses contract confidence zero', async () => {
    const base = projection().pages[0];
    const candidate = projectionWithPage({
      boxes: [{ ...base.boxes?.[0], confidence: null } as OcrBox],
      confidence: 0,
    });
    const evidence = await buildOcrEvidence({ projection: candidate, expected: expectedIdentity() });
    expect(evidence.pages[0]).toMatchObject({
      confidence: 0,
      confidenceSummary: { scoreState: 'none', numericCount: 0, min: null, max: null, mean: null },
    });
  });

  it('preserves runtime page confidence independently from box score statistics', async () => {
    const candidate = projectionWithPage({ boxes: [box(0.1), box(0.2)], confidence: 0.9 });
    const evidence = await buildOcrEvidence({ projection: candidate, expected: expectedIdentity() });

    expect(evidence.pages[0].confidence).toBe(0.9);
    expect(evidence.pages[0].confidenceSummary).toEqual({
      scoreState: 'numeric',
      numericCount: 2,
      min: 0.1,
      max: 0.2,
      mean: 0.15,
    });
  });

  it('accepts recognized text with no boxes when runtime confidence is numeric', async () => {
    const candidate = projectionWithPage({ boxes: [], confidence: 0.91 });
    const evidence = await buildOcrEvidence({ projection: candidate, expected: expectedIdentity() });

    expect(evidence.pages[0]).toMatchObject({ confidence: 0.91, boxCount: 0 });
    expect(evidence.pages[0].confidenceSummary).toEqual({
      scoreState: 'none',
      numericCount: 0,
      min: null,
      max: null,
      mean: null,
    });
  });

  it.each([0, 1, 0.9, 0.0001])(
    'accepts canonical page confidence %s',
    async (confidence) => {
      const evidence = await buildOcrEvidence({
        projection: projectionWithPage({ confidence }),
        expected: expectedIdentity(),
      });
      expect(evidence.pages[0].confidence).toBe(confidence);
      expect(JSON.stringify(evidence)).not.toMatch(/(?:e\+|-0)/u);
    },
  );

  it.each([-0, 0.00001, 1e-7])(
    'rejects non-canonical page confidence %s',
    async (confidence) => {
      await expect(buildOcrEvidence({
        projection: projectionWithPage({ confidence }),
        expected: expectedIdentity(),
      })).rejects.toThrow(/canonical/u);
    },
  );

  it('produces the checked-in privacy-safe golden evidence through the real builder', async () => {
    const evidence = await buildOcrEvidence({
      projection: goldenProjection(),
      expected: goldenExpectedIdentity(),
    });
    expect(evidence).toEqual(goldenEvidence);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/raw|polygon|box-secret|Bearer|token|[A-Z]:\\/iu);
  });

  it('rounds numeric confidence statistics to four decimals and aggregates by score count', async () => {
    const candidate = projectionWithPage({
      boxes: [
      box(0.6666),
      box(0.6667),
      box(0.6668),
      ],
      confidence: 0.6667,
    });
    const evidence = await buildOcrEvidence({ projection: candidate, expected: expectedIdentity() });
    expect(evidence.pages[0].confidenceSummary).toEqual({
      scoreState: 'numeric',
      numericCount: 3,
      min: 0.6666,
      max: 0.6668,
      mean: 0.6667,
    });
    expect(evidence.summary.confidenceSummary).toEqual(evidence.pages[0].confidenceSummary);
  });

  it('aggregates raw box scores across pages before rounding the aggregate mean', async () => {
    const candidate = projectionWithPages(
      { boxes: [box(0.10001), box(0.10001)], confidence: 0.1 },
      { boxes: [box(0.10007), box(0.10009)], confidence: 0.1001 },
    );
    const evidence = await buildOcrEvidence({ projection: candidate, expected: expectedIdentity() });

    expect(evidence.summary.confidenceSummary).toMatchObject({
      scoreState: 'numeric',
      numericCount: 4,
      mean: 0.1,
    });
  });

  it('retains failed zero-page evidence using the expected source identity', async () => {
    const candidate: CaptureOcrProjection = {
      ...projection(),
      status: 'failed',
      source: null,
      pageCount: 0,
      pages: [],
      provenance: unavailableProvenance(),
      failure: {
        code: 'ocr_worker_failed',
        message: 'C:\\private\\token.txt Bearer top-secret',
        stage: 'ocr',
        retryable: false,
      },
    };
    const evidence = await buildOcrEvidence({ projection: candidate, expected: expectedIdentity('failed') });

    expect(evidence).toMatchObject({
      status: 'failed',
      sourceSha256: 'a'.repeat(64),
      pageCount: 0,
      pages: [],
      failure: { code: 'ocr_worker_failed' },
    });
  });

  it('rejects completed projections without a recognized page', async () => {
    const candidate = projectionWithPage({ status: 'empty', text: '', boxes: [], confidence: null });

    await expect(buildOcrEvidence({ projection: candidate, expected: expectedIdentity() }))
      .rejects.toThrow(/recognized/u);
  });

  it('rejects raster scales above the contract maximum', async () => {
    const base = projection().pages[0];
    const candidate = projectionWithPage({ raster: { ...base.raster, scale: 9 } });

    await expect(buildOcrEvidence({ projection: candidate, expected: expectedIdentity() }))
      .rejects.toThrow(/scale/u);
  });

  it('rejects an all-zero resolved model digest', async () => {
    const zeroDigest = {
      ...resolvedProvenance(),
      modelDigest: `sha256:${'0'.repeat(64)}`,
    };
    const base = projection();
    const candidate: CaptureOcrProjection = {
      ...base,
      provenance: zeroDigest,
      pages: [{ ...base.pages[0], provenance: zeroDigest }],
    };

    await expect(buildOcrEvidence({ projection: candidate, expected: expectedIdentity() }))
      .rejects.toThrow(/modelDigest/u);
  });

  it('rejects a present source identity mismatch even when expected identity matches it', async () => {
    const base = projection();
    if (!base.source) throw new Error('fixture source is required');
    const candidate: CaptureOcrProjection = {
      ...base,
      source: { ...base.source, sha256: 'b'.repeat(64) },
    };

    await expect(buildOcrEvidence({ projection: candidate, expected: expectedIdentity() }))
      .rejects.toThrow(/sourceSha256/u);
  });

  it('includes complete runtime/model/device/profile/worker provenance', async () => {
    const resolved = await buildOcrEvidence({ projection: projection(), expected: expectedIdentity() });
    expect(resolved.provenance).toEqual({
      status: 'resolved',
      runtimeVersion: '0.4.2',
      contractSha256: 'c'.repeat(64),
      engine: 'windowsml-ocr',
      model: 'ppocrv6-traditional-multilingual',
      modelDigest: `sha256:${'d'.repeat(64)}`,
      device: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
      workerSha256: 'f'.repeat(64),
    });

    const unavailable = await buildOcrEvidence({
      projection: failedProjection(failedPage(), unavailableProvenance()),
      expected: expectedIdentity('failed'),
    });
    expect(unavailable.provenance).toMatchObject({
      status: 'unavailable',
      runtimeVersion: '0.4.2',
      contractSha256: 'c'.repeat(64),
      engine: null,
      model: null,
      modelDigest: null,
      device: null,
      workerSha256: 'f'.repeat(64),
    });
  });

  it('uses a deterministic canonical digest and excludes source OCR content', async () => {
    const first = await buildOcrEvidence({ projection: projection(), expected: expectedIdentity() });
    const secondProjection = projectionWithPage({ text: '另一段同樣長度' });
    const second = await buildOcrEvidence({ projection: secondProjection, expected: expectedIdentity() });
    expect(second.digest).not.toBe(first.digest);

    const repeat = await buildOcrEvidence({ projection: projection(), expected: expectedIdentity() });
    expect(repeat.digest).toBe(first.digest);
    expect(JSON.stringify(first)).not.toContain('另一段同樣長度');
  });

  it.each([
    ['polygon', () => {
      const base = projection().pages[0].boxes?.[0] as OcrBox;
      return projectionWithPage({
        boxes: [{ ...base, polygon: [{ ...base.polygon[0], x: Number.NaN }, ...base.polygon.slice(1)] }],
      });
    }],
    ['confidence', () => {
      const base = projection().pages[0].boxes?.[0] as OcrBox;
      return projectionWithPage({ boxes: [{ ...base, confidence: 2 }] });
    }],
    ['malformed failure', () => {
      const candidate = failedProjection(failedPage(), unavailableProvenance());
      return {
        ...candidate,
        pages: [{ ...candidate.pages[0], failure: { code: 'bad code', message: 'failure' } }],
      };
    }],
  ])('fails closed on malformed %s values', async (_label, makeCandidate) => {
    await expect(buildOcrEvidence({
      projection: makeCandidate(),
      expected: expectedIdentity(_label === 'malformed failure' ? 'failed' : 'completed'),
    })).rejects.toThrow(/Invalid OCR evidence/u);
  });
});

function buildOcrEvidence(
  input: Parameters<typeof buildOcrEvidence$>[0],
) {
  return firstValueFrom(buildOcrEvidence$(input));
}

function expectedIdentity(terminalStatus: 'completed' | 'failed' = 'completed') {
  return {
    captureId: 'capture-1',
    sourceSha256: 'a'.repeat(64),
    runtimeVersion: '0.4.2',
    contractSha256: 'c'.repeat(64),
    terminalStatus,
    workerSha256: 'f'.repeat(64),
  };
}

function goldenExpectedIdentity() {
  return {
    ...expectedIdentity(),
    captureId: 'capture-中文-😀',
  };
}

function projection(): CaptureOcrProjection {
  return {
    apiVersion: '2.0',
    schemaVersion: '3',
    captureId: 'capture-1',
    status: 'completed',
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'fixture.jpeg',
      mediaType: 'image/jpeg',
      bytes: 45_494,
    },
    pageCount: 1,
    pages: [
      {
        page: 1,
        status: 'recognized',
        raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' },
        text: '敏感 raw text',
        boxes: [
          {
            polygon: [
              { x: 100, y: 120 },
              { x: 220, y: 120 },
              { x: 220, y: 160 },
              { x: 100, y: 160 },
            ],
            text: 'box-secret',
            confidence: 0.875,
          },
        ],
        confidence: 0.875,
        provenance: resolvedProvenance(),
      },
    ],
    runtimeVersion: '0.4.2',
    contractSha256: 'c'.repeat(64),
    provenance: resolvedProvenance(),
    createdAt: '2026-08-29T00:00:00Z',
  };
}

function projectionWithPage(overrides: Partial<OcrPageProjection>): CaptureOcrProjection {
  const base = projection();
  return {
    ...base,
    pages: [{ ...base.pages[0], ...overrides }],
  };
}

function projectionWithPages(
  firstOverrides: Partial<OcrPageProjection>,
  secondOverrides: Partial<OcrPageProjection>,
): CaptureOcrProjection {
  const base = projection();
  return {
    ...base,
    pageCount: 2,
    pages: [
      { ...base.pages[0], ...firstOverrides, page: 1 },
      { ...base.pages[0], ...secondOverrides, page: 2 },
    ],
  };
}

function goldenProjection(): CaptureOcrProjection {
  const base = projection();
  const provenance = {
    ...resolvedProvenance(),
    model: '模型-ppocrv6',
    device: 'GPU-😀',
    profileId: '配置-1',
  };
  return {
    ...base,
    captureId: 'capture-中文-😀',
    pages: [
      { ...base.pages[0], page: 1, text: '甲', boxes: [], confidence: 0, provenance },
      { ...base.pages[0], page: 2, text: '乙', boxes: [box(1)], confidence: 1, provenance },
      { ...base.pages[0], page: 3, text: '丙', boxes: [box(0.9)], confidence: 0.9, provenance },
      { ...base.pages[0], page: 4, text: '丁', boxes: [box(0.0001)], confidence: 0.0001, provenance },
    ],
    pageCount: 4,
    provenance,
  };
}

function failedProjection(page: OcrPageProjection, provenance: OcrProvenance): CaptureOcrProjection {
  return {
    ...projection(),
    status: 'failed',
    pages: [page],
    provenance,
    failure: {
      code: 'ocr_failed',
      message: 'C:\\private\\token.txt Bearer top-secret',
      stage: 'ocr',
      retryable: false,
    },
  };
}

function emptyPage(): OcrPageProjection {
  const base = projection().pages[0];
  return {
    ...base,
    status: 'empty',
    text: '',
    boxes: [],
    confidence: null,
  };
}

function failedPage(): OcrPageProjection {
  return {
    ...projection().pages[0],
    status: 'failed',
    text: '',
    boxes: [],
    confidence: null,
    provenance: unavailableProvenance(),
    failure: {
      code: 'ocr_worker_failed',
      message: 'C:\\private\\token.txt Bearer top-secret',
      stage: 'ocr',
      retryable: true,
    },
  };
}

function unavailableProvenance() {
  return {
    status: 'unavailable' as const,
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
    reason: 'worker_crashed' as const,
  };
}

function box(confidence: number | null): OcrBox {
  return {
    polygon: [
      { x: 100, y: 120 },
      { x: 220, y: 120 },
      { x: 220, y: 160 },
      { x: 100, y: 160 },
    ],
    text: 'box-secret',
    confidence,
  };
}

function resolvedProvenance() {
  return {
    status: 'resolved' as const,
    engine: 'windowsml-ocr' as const,
    model: 'ppocrv6-traditional-multilingual',
    modelDigest: `sha256:${'d'.repeat(64)}`,
    device: 'NVIDIA GeForce RTX 4060 Laptop GPU',
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
  };
}
