import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isAllowedWorkerStage,
  sanitizeWorkerStage,
  WORKER_STAGE_BUILDER_NAMES,
} from './generated-worker-stage-policy.ts';

test('generated worker stage policy matches the shared corpus and builder inventory', async () => {
  const corpus = JSON.parse(await readFile(
    new URL('../packages/capture-runtime/src/capture_runtime/assets/worker-stage-policy-corpus.json', import.meta.url),
    'utf8',
  )) as Array<{ input: string; expected: string | null }>;
  assert.ok(WORKER_STAGE_BUILDER_NAMES.has('ocr_stage_failure'));
  for (const testCase of corpus) {
    assert.equal(sanitizeWorkerStage(testCase.input), testCase.expected);
    assert.equal(isAllowedWorkerStage(testCase.input), testCase.expected === testCase.input);
  }
});
