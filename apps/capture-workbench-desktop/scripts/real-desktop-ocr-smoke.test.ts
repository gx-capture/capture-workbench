import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertExpectedOcrDevice,
  assertRealDesktopSmokeEvidence,
  isOwnedSmokeDocumentName,
  parseOcrProvenance,
  realDesktopRuntimeReadyTimeoutMs,
  resolveExpectedOcrDevice,
} from './real-desktop-ocr-smoke.ts';

test('real desktop OCR evidence requires real engines, Ollama provenance, cleanup, and redaction', () => {
  assert.equal(realDesktopRuntimeReadyTimeoutMs, 180_000);
  const valid = {
    evidenceKind: 'real-standalone-tauri-ui-ocr',
    releaseGateSatisfied: true,
    realEnginesExercised: true,
    sourceKind: 'pdf',
    rawOcrVisible: true,
    ocrDevice: 'windowsml-dml',
    structuringEngine: 'ollama',
    model: 'capture-workbench-qwen3.5-4b-structure-v1',
    modelDigest: `sha256:${'a'.repeat(64)}`,
    documentDeletedAfterVerification: true,
  };

  assert.doesNotThrow(() => assertRealDesktopSmokeEvidence(valid));
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, structuringEngine: 'deterministic' }),
    /Expected values to be strictly equal/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, modelDigest: 'not-a-digest' }),
    /did not match/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, documentDeletedAfterVerification: false }),
    /Expected values to be strictly equal/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, ocrDevice: 'unknown' }),
    /falsy value|false/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, note: 'C:\\outside\\source.pdf' }),
    /expected to not match/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, authorization: 'Bearer unsafe' }),
    /authorization material/u,
  );
});

test('real desktop OCR cleanup owns only UUID-named smoke documents', () => {
  assert.equal(
    isOwnedSmokeDocumentName(
      'standalone-real-ocr-099eca42-23f6-42ca-a3f6-05da5afd00ba.pdf',
    ),
    true,
  );
  assert.equal(isOwnedSmokeDocumentName('standalone-real-ocr-user-file.pdf'), false);
  assert.equal(
    isOwnedSmokeDocumentName(
      'standalone-real-ocr-099eca42-23f6-42ca-a3f6-05da5afd00ba.pdf.backup',
    ),
    false,
  );
});

test('DirectML smoke CLI requirement rejects CPU provenance', () => {
  assert.equal(
    resolveExpectedOcrDevice(
      ['--expected-ocr-device', 'windowsml-dml'],
      'cpu',
    ),
    'windowsml-dml',
  );
  assert.doesNotThrow(() =>
    assertExpectedOcrDevice('windowsml-dml', 'windowsml-dml'),
  );
  assert.throws(
    () => assertExpectedOcrDevice('cpu', 'windowsml-dml'),
    /used cpu; expected windowsml-dml/u,
  );
  assert.throws(
    () => resolveExpectedOcrDevice(['--expected-ocr-device', 'unknown']),
    /must be windowsml-dml or cpu/u,
  );
});

test('real desktop cleanup selects and verifies an exact filename within the detail pane', async () => {
  const source = await readFile(
    new URL('./real-desktop-ocr-smoke.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /getByText\(fileName, \{ exact: true \}\)/u);
  assert.doesNotMatch(source, /filter\(\{ hasText: fileName \}\)/u);
  assert.match(source, /locator\('\.detail-pane'\)/u);
  assert.match(source, /selectedFileName\?\.trim\(\),\s*fileName/u);
  assert.match(
    source,
    /detailPane\.getByRole\('button', \{ name: '刪除', exact: true \}\)/u,
  );
});

test('real desktop OCR provenance accepts the runtime PDF composite engine', () => {
  assert.deepEqual(
    parseOcrProvenance([
      'pdf-embedded+windowsml-ocr · pp-ocrv6-medium-windowsml · windowsml-dml',
    ]),
    {
      engine: 'pdf-embedded+windowsml-ocr',
      model: 'pp-ocrv6-medium-windowsml',
      device: 'windowsml-dml',
    },
  );
  assert.throws(
    () => parseOcrProvenance(['pdf-embedded · pypdf · cpu']),
    /recognized OCR device provenance/u,
  );
});
