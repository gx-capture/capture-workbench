// The test-scripts target preloads tools/test-temp-root.ts with `node --import`
// (an import here would cross the Nx project boundary); these tests also remove
// their own directories, so a direct `node --test` run leaves nothing behind.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';

import {
  assertPackagedJourneyEvidence,
  assertPackagedSnapshotsAreNotUpdated,
  baselineReviewArtifactRoot,
  checkpointNameOf,
  packagedJourneyVerdict,
  packagedWorkerMirrorCleanedUp,
  resolvePackagedJourneyRun,
  writePackagedJourneyEvidence,
  type PackagedJourneyEvidence,
} from './packaged-journey-run.ts';

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryRoots.map((directory) => rm(directory, { recursive: true, force: true })));
});

const workspace = resolve('C:\\workspace');

function evidence(overrides: Partial<PackagedJourneyEvidence> = {}): PackagedJourneyEvidence {
  return {
    evidenceKind: 'packaged-real-engine-journey',
    journey: 'asr',
    mode: 'baseline-review',
    runId: 'review-1',
    status: 'completed',
    runtimeSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    screenshots: ['asr-ready', 'engine-removed'],
    comparisons: [
      { name: 'asr-ready', outcome: 'matched' },
      { name: 'engine-removed', outcome: 'matched' },
    ],
    provenance: { engine: 'speech-recognition', model: 'synthetic-model', device: 'cuda' },
    cleanup: { app: true, sidecar: true, cdpPort: true, runData: true, workerMirror: true },
    ...overrides,
  };
}

test('a baseline review and release acceptance never share one run', () => {
  assert.throws(
    () => resolvePackagedJourneyRun({ E2E_ACCEPTANCE_RUN_ID: 'a', E2E_BASELINE_REVIEW_RUN_ID: 'b' }, workspace),
    /exclude each other/u,
  );
  assert.equal(resolvePackagedJourneyRun({}, workspace), undefined);
});

test('a baseline review keeps its artifacts in its own folder and names no acceptance run', () => {
  const run = resolvePackagedJourneyRun({ E2E_BASELINE_REVIEW_RUN_ID: 'review-1', E2E_RECORD_VIDEO: '0' }, workspace);
  assert.deepEqual(run, {
    mode: 'baseline-review',
    runId: 'review-1',
    artifactRoot: baselineReviewArtifactRoot(workspace, 'review-1'),
    recordVideo: false,
  });
  assert.throws(
    () => resolvePackagedJourneyRun({ E2E_BASELINE_REVIEW_RUN_ID: 'review-1', E2E_ARTIFACT_ROOT: 'C:\\elsewhere' }, workspace),
    /capture-workbench-review/u,
  );
  assert.throws(() => resolvePackagedJourneyRun({ E2E_BASELINE_REVIEW_RUN_ID: '../up' }, workspace), /run ID is invalid/u);
});

test('acceptance keeps its artifacts where the acceptance contract puts them', () => {
  const run = resolvePackagedJourneyRun({ E2E_ACCEPTANCE_RUN_ID: 'accept-1', E2E_RECORD_VIDEO: 'true' }, workspace);
  assert.deepEqual(run, {
    mode: 'acceptance',
    runId: 'accept-1',
    artifactRoot: resolve(workspace, 'output', 'playwright', 'capture-workbench', 'accept-1'),
    recordVideo: true,
  });
  assert.throws(
    () => resolvePackagedJourneyRun({ E2E_ACCEPTANCE_RUN_ID: 'accept-1', E2E_ARTIFACT_ROOT: 'C:\\elsewhere' }, workspace),
    /output\/playwright\/capture-workbench\/<run-id> in acceptance/u,
  );
});

test('review evidence never names a runtime candidate and acceptance evidence always does', () => {
  assertPackagedJourneyEvidence(evidence());
  assert.throws(() => assertPackagedJourneyEvidence(evidence({ candidateId: 'c'.repeat(64) })), /never names a runtime candidate/u);
  assertPackagedJourneyEvidence(evidence({ mode: 'acceptance', candidateId: 'c'.repeat(64) }));
  assert.throws(() => assertPackagedJourneyEvidence(evidence({ mode: 'acceptance' })), /must name its runtime candidate/u);
});

test('packaged journeys reject every effective Playwright snapshot update mode', () => {
  assert.doesNotThrow(() => assertPackagedSnapshotsAreNotUpdated('none'));
  for (const update of ['all', 'changed', 'missing', 'default'] as const) {
    assert.throws(() => assertPackagedSnapshotsAreNotUpdated(update), /require updateSnapshots: none/u);
  }
});

test('a fresh OCR review proves worker cleanup when its release mirror served a request and closed', () => {
  const reviewMirror = { requests: 1 };
  assert.equal(packagedWorkerMirrorCleanedUp(true, true, reviewMirror), true);
  assert.equal(packagedWorkerMirrorCleanedUp(false, true, reviewMirror), false);
  assert.equal(packagedWorkerMirrorCleanedUp(true, true, { requests: 0 }), false);
  assert.equal(packagedWorkerMirrorCleanedUp(true, true, undefined), false);
  assert.equal(packagedWorkerMirrorCleanedUp(true, false, { requests: 0 }), true);
});

test('a journey completes only when its work, every expected comparison and cleanup pass', () => {
  const { screenshots: names, comparisons, cleanup } = evidence();
  assert.equal(packagedJourneyVerdict('completed', names, comparisons, cleanup), 'completed');
  assert.equal(packagedJourneyVerdict('failed', names, comparisons, cleanup), 'failed');
  assert.equal(packagedJourneyVerdict('completed', names, comparisons.slice(0, 1), cleanup), 'failed');
  assert.equal(packagedJourneyVerdict('completed', names, comparisons, { ...cleanup, sidecar: false }), 'failed');
  for (const outcome of ['differed', 'baseline missing'] as const) {
    assert.equal(packagedJourneyVerdict('completed', names, [
      { name: 'asr-ready', outcome },
      { name: 'engine-removed', outcome: 'matched' },
    ], cleanup), 'failed');
  }
});

test('journey evidence holds no local path and no authorization material', () => {
  assert.throws(
    () => assertPackagedJourneyEvidence(evidence({ provenance: { engine: 'speech-recognition', model: 'C:\\Users\\someone\\model', device: 'cuda' } })),
    /must not hold a local path/u,
  );
  assert.throws(
    () => assertPackagedJourneyEvidence(evidence({ provenance: { engine: 'speech-recognition', model: 'Bearer abc', device: 'cuda' } })),
    /authorization material/u,
  );
});

test('journey evidence is written per journey into the run\'s artifact root', async () => {
  const root = await temporaryDirectory('journey-evidence-');
  const path = await writePackagedJourneyEvidence(root, evidence());
  assert.equal(path, join(root, 'asr-journey-evidence.json'));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), evidence());
  assert.equal(checkpointNameOf(root, join(root, 'asr-result.png')), 'asr-result');
  assert.throws(() => checkpointNameOf(root, join(root, 'nested', 'asr-result.png')), /directly in the run's artifact root/u);
});
