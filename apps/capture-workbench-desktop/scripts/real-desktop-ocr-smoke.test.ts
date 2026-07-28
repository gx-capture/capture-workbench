import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRealDesktopSmokeEvidence } from './real-desktop-ocr-smoke.ts';

test('real desktop OCR evidence requires real engines, Ollama provenance, cleanup, and redaction', () => {
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
