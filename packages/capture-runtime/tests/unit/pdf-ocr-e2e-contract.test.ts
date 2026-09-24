import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPdfOcrRawCapture,
  captureWatchdogSignature,
  formatCaptureWatchdogCheckpoint,
  isolatedEnvironment,
  parseExpectedAnchors,
  parseExpectedPages,
} from '../e2e/support/pdf-ocr-journey.ts';
import { parseOnlinePackageOptions } from '../e2e/online-package/pdf-ocr.e2e.ts';

test('V2 PDF OCR watchdog reports only privacy-safe progress fields', () => {
  const first = {
    status: 'extracting',
    progress: 0.25,
    partialRevision: 2,
    lastEventSequence: 7,
    updatedAt: '2026-08-25T02:00:00Z',
  };
  const later = { ...first, progress: 0.5, lastEventSequence: 8 };

  assert.equal(
    formatCaptureWatchdogCheckpoint(first),
    '[pdf-ocr-v2-watchdog] status=extracting progress=25% partialRevision=2 lastEventSequence=7 updatedAt=2026-08-25T02:00:00Z',
  );
  assert.notEqual(
    captureWatchdogSignature(first),
    captureWatchdogSignature(later),
  );
  assert.doesNotMatch(formatCaptureWatchdogCheckpoint(first), /captureId|text|path/u);
});

test('local-package PDF OCR E2E uses a dedicated complete worker URL contract', () => {
  const environment = isolatedEnvironment(
    'C:\\temp\\pdf-ocr-e2e',
    43124,
    'test-token',
    'http://127.0.0.1:43125/capture-engine-ocr-test.zip',
    {
      PATH: 'test-path',
      CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
      CAPTURE_SMOKE_WORKER_MIRROR_URL: 'http://127.0.0.1:9999',
    },
    'C:\\temp\\ocr-model-source',
  );

  assert.equal(environment.PATH, 'test-path');
  assert.equal(environment.CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN, '1');
  assert.equal(
    environment.CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL,
    'http://127.0.0.1:43125/capture-engine-ocr-test.zip',
  );
  assert.equal(environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN, '1');
  assert.equal(
    environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT,
    'C:\\temp\\ocr-model-source',
  );
  assert.equal(environment.CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN, undefined);
  assert.equal(environment.CAPTURE_SMOKE_WORKER_MIRROR_URL, undefined);
});

test('online-package PDF OCR E2E removes every local worker URL override', () => {
  const environment = isolatedEnvironment(
    'C:\\temp\\pdf-ocr-online-e2e',
    43124,
    'test-token',
    undefined,
    {
      CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN: '1',
      CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL:
        'http://127.0.0.1:9999/untrusted-worker.zip',
      CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
      CAPTURE_SMOKE_WORKER_MIRROR_URL: 'http://127.0.0.1:9998',
    },
  );

  assert.equal(
    environment.CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN,
    undefined,
  );
  assert.equal(environment.CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL, undefined);
  assert.equal(environment.CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN, undefined);
  assert.equal(environment.CAPTURE_SMOKE_WORKER_MIRROR_URL, undefined);
  assert.equal(environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN, undefined);
  assert.equal(environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT, undefined);
});

test('online-package PDF OCR E2E pins one official immutable runtime package', () => {
  const expectedRuntimeSha256 = 'a'.repeat(64);
  assert.deepEqual(
    parseOnlinePackageOptions({
      CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_VERSION: '0.5.0',
      CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_SHA256: expectedRuntimeSha256,
    }),
    {
      runtimeVersion: '0.5.0',
      expectedRuntimeSha256,
      baseUrl:
        'https://github.com/gx-capture/capture-workbench/releases/download/v0.5.0',
    },
  );
  assert.throws(
    () => parseOnlinePackageOptions({}),
    /ONLINE_RUNTIME_VERSION/u,
  );
  assert.throws(
    () =>
      parseOnlinePackageOptions({
        CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_VERSION: '0.5.0',
        CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_SHA256: expectedRuntimeSha256,
        CAPTURE_PDF_OCR_E2E_ONLINE_RELEASE_BASE_URL:
          'https://example.test/untrusted',
      }),
    /official HTTPS GitHub release URL/u,
  );
});

test('real PDF OCR E2E options require explicit semantic anchors and page count', () => {
  assert.deepEqual(
    parseExpectedAnchors(
      '[{"page":2,"text":"食品の腐敗"},{"page":41,"text":"問題3"}]',
    ),
    [
      { page: 2, text: '食品の腐敗' },
      { page: 41, text: '問題3' },
    ],
  );
  assert.equal(parseExpectedPages('44'), 44);
  assert.throws(() => parseExpectedAnchors('[]'), /at least|non-empty/u);
  assert.throws(() => parseExpectedPages('0'), /integer from 1/u);
});

test('real PDF OCR E2E evidence accepts only all-page PaddleOCR semantics', () => {
  const evidence = assertPdfOcrRawCapture(
    {
      sourceText: '食品の 腐敗\n問題3',
      segments: [
        { locator: { kind: 'page', page: 1 }, text: '食品の腐敗' },
        { locator: { kind: 'page', page: 2 }, text: '問題3' },
      ],
      extractionEngine: {
        engine: 'windowsml-ocr',
        model: 'pp-ocrv6-medium-windowsml',
        digest: `sha256:${'a'.repeat(64)}`,
        device: 'windowsml-dml',
      },
    },
    2,
    [
      { page: 1, text: '食品の腐敗' },
      { page: 2, text: '問題3' },
    ],
  );

  assert.equal(evidence.observedPages, 2);
  assert.equal(evidence.allPagesContainText, true);
  assert.equal(evidence.matchedAnchorCount, 2);
  assert.equal(evidence.sampledPageCount, 2);
  assert.ok(evidence.matchedExpectedCharacterCount > 0);
  assert.equal(
    evidence.matchMode,
    'nfkc-whitespace-insensitive-exact-substring',
  );
  assert.equal(evidence.extractionEngine, 'windowsml-ocr');
});

test('real PDF OCR E2E evidence rejects missing pages and embedded-text engines', () => {
  const raw = {
    sourceText: '食品の腐敗',
    segments: [
      { locator: { kind: 'page', page: 1 }, text: '食品の腐敗' },
    ],
    extractionEngine: {
      engine: 'pdf-embedded',
      model: 'pypdf',
      digest: `sha256:${'b'.repeat(64)}`,
      device: 'cpu',
    },
  };
  assert.throws(
    () =>
      assertPdfOcrRawCapture(raw, 2, [
        { page: 1, text: '食品の腐敗' },
      ]),
    /windowsml-ocr/u,
  );
});
