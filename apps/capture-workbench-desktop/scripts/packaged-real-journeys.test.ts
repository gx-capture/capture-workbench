// The test-scripts target preloads tools/test-temp-root.ts with `node --import`
// (an import here would cross the Nx project boundary); these tests also remove
// their own directories, so a direct `node --test` run leaves nothing behind.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';

import { captureMissingCheckpointBaseline } from './packaged-checkpoint-comparison.ts';
import {
  checkpointsToReview,
  journeysEnvironment,
  missingJourneyInputs,
  parsePackagedJourneysArguments,
  planReviewRelease,
} from './packaged-real-journeys.ts';

const temporaryRoots: string[] = [];

test('review stages the runtime and serves workers from one release directory', () => {
  const defaultPlan = planReviewRelease({});
  assert.match(defaultPlan.environment.CAPTURE_REAL_DESKTOP_RELEASE_DIR, /packages[\\/]capture-runtime[\\/]dist[\\/]release$/u);
  const override = resolve('synthetic-review-release');
  const plan = planReviewRelease({ CAPTURE_REAL_DESKTOP_RELEASE_DIR: override });
  assert.equal(plan.environment.CAPTURE_REAL_DESKTOP_RELEASE_DIR, override);
  assert.deepEqual(plan.stage, {
    artifactPath: join(override, 'capture-runtime-x86_64-pc-windows-msvc.exe'),
    manifestPath: join(override, 'capture-runtime-manifest.json'),
    schemaPath: join(override, 'capture-document-v2.schema.json'),
    source: 'release',
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryRoots.map((directory) => rm(directory, { recursive: true, force: true })));
});

test('a review runs both journeys unless one is named; acceptance here is the ASR journey only', () => {
  assert.deepEqual(parsePackagedJourneysArguments(['--mode', 'baseline-review']), { mode: 'baseline-review', journeys: ['ocr', 'asr'] });
  assert.deepEqual(parsePackagedJourneysArguments(['--mode', 'baseline-review', '--journey', 'asr']), { mode: 'baseline-review', journeys: ['asr'] });
  assert.deepEqual(parsePackagedJourneysArguments(['--mode', 'baseline-review', '--journey=ocr']), { mode: 'baseline-review', journeys: ['ocr'] });
  assert.deepEqual(parsePackagedJourneysArguments(['--mode', 'acceptance', '--journey', 'asr']), { mode: 'acceptance', journeys: ['asr'] });
  assert.throws(() => parsePackagedJourneysArguments(['--mode', 'acceptance']), /diagnostic-desktop-ocr/u);
  assert.throws(() => parsePackagedJourneysArguments(['--mode', 'acceptance', '--journey', 'ocr']), /diagnostic-desktop-ocr/u);
  assert.throws(() => parsePackagedJourneysArguments(['--mode', 'release']), /--mode/u);
  assert.throws(() => parsePackagedJourneysArguments(['--mode', 'baseline-review', '--journey', 'pdf']), /--journey/u);
});

test('missing inputs are named before anything is launched', () => {
  assert.deepEqual(missingJourneyInputs(parsePackagedJourneysArguments(['--mode', 'baseline-review']), {}), [
    'CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT',
    'CAPTURE_REAL_DESKTOP_OCR_PDF or CAPTURE_REAL_DESKTOP_OCR_INPUT',
    'CAPTURE_REAL_DESKTOP_ASR_RECORDING',
  ]);
  assert.deepEqual(
    missingJourneyInputs(parsePackagedJourneysArguments(['--mode', 'acceptance', '--journey', 'asr']), {
      CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT: 'C:\\cw163',
      CAPTURE_REAL_DESKTOP_ASR_RECORDING: 'C:\\recording.m4a',
    }),
    ['CAPTURE_RUNTIME_CANDIDATE_ROOT', 'CAPTURE_RUNTIME_CANDIDATE_ID', 'CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE'],
  );
});

test('a review run carries only the review run ID, and acceptance only the acceptance run ID', () => {
  const review = journeysEnvironment(
    parsePackagedJourneysArguments(['--mode', 'baseline-review']),
    { E2E_ACCEPTANCE_RUN_ID: 'left-over' },
    'review-1',
  );
  assert.equal(review.E2E_ACCEPTANCE_RUN_ID, undefined);
  assert.equal(review.E2E_BASELINE_REVIEW_RUN_ID, 'review-1');
  assert.match(String(review.E2E_ARTIFACT_ROOT), /capture-workbench-review[\\/]review-1$/u);
  assert.equal(review.CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE, 'directml');
  const acceptance = journeysEnvironment(
    parsePackagedJourneysArguments(['--mode', 'acceptance', '--journey', 'asr']),
    { E2E_BASELINE_REVIEW_RUN_ID: 'left-over' },
    'accept-1',
  );
  assert.equal(acceptance.E2E_BASELINE_REVIEW_RUN_ID, undefined);
  assert.equal(acceptance.E2E_ACCEPTANCE_RUN_ID, 'accept-1');
  assert.match(String(acceptance.E2E_ARTIFACT_ROOT), /capture-workbench[\\/]accept-1$/u);
});

test('the approval list includes Playwright diffs and actual images captured for missing baselines', async () => {
  const results = await temporaryDirectory('test-results-');
  const testDirectory = join(results, 'real-desktop-asr-acceptance-spec-chromium');
  await mkdir(testDirectory, { recursive: true });
  for (const file of ['asr-ready-actual.png', 'asr-ready-expected.png', 'asr-ready-diff.png']) {
    await writeFile(join(testDirectory, file), 'png');
  }
  const existingBaseline = join(results, 'asr-ready-chromium-win32.png');
  const missingBaseline = join(results, 'asr-result-chromium-win32.png');
  await writeFile(existingBaseline, 'approved png');
  const outputPath = (file: string): string => join(testDirectory, file);
  const save = (path: string): Promise<void> => writeFile(path, 'masked png');
  assert.equal(await captureMissingCheckpointBaseline(existingBaseline, 'asr-ready', outputPath, save), undefined);
  assert.equal(await readFile(outputPath('asr-ready-actual.png'), 'utf8'), 'png');
  assert.deepEqual(await captureMissingCheckpointBaseline(missingBaseline, 'asr-result', outputPath, save), {
    name: 'asr-result',
    outcome: 'baseline missing',
  });
  assert.deepEqual(
    (await checkpointsToReview(results)).map(({ name, baseline }) => ({ name, baseline })),
    [{ name: 'asr-ready', baseline: 'differs' }, { name: 'asr-result', baseline: 'missing' }],
  );
  assert.equal(await readFile(outputPath('asr-result-actual.png'), 'utf8'), 'masked png');
  await assert.rejects(readFile(missingBaseline), { code: 'ENOENT' });
  assert.deepEqual(await checkpointsToReview(join(results, 'absent')), []);
});
