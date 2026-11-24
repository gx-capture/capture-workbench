// How a real-engine journey on the packaged Desktop App runs, and the
// evidence it leaves when it is not the OCR acceptance manifest:
//
//   acceptance       E2E_ACCEPTANCE_RUN_ID: bound to a runtime candidate
//                    (CAPTURE_RUNTIME_CANDIDATE_ROOT / _ID); its evidence
//                    names the candidate. Its artifact root follows the
//                    acceptance contract (createAcceptanceRun in
//                    tools/acceptance-contract.ts), which the OCR journey
//                    also builds its acceptance manifest from.
//   baseline-review  E2E_BASELINE_REVIEW_RUN_ID: the local acceptance build
//                    with the local release runtime and no candidate, so
//                    that screenshots can be reviewed before a candidate
//                    exists. Its evidence says baseline-review and names no
//                    candidate; it never counts as release acceptance, and
//                    it never updates a baseline.
//
// The two run IDs exclude each other. Without either, only the OCR journey
// runs, as the local smoke without screenshots.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { assertRedactedEvidence } from './hash-qa-installer.ts';

export type PackagedJourneyMode = 'acceptance' | 'baseline-review';
export type PackagedJourney = 'ocr' | 'asr';

// Every value but 'none' can write a baseline (Playwright's 'default' writes missing ones).
export function assertPackagedSnapshotsAreNotUpdated(effectiveUpdate: string): void {
  if (effectiveUpdate !== 'none') {
    throw new Error('Packaged journeys require updateSnapshots: none. Copy owner-approved images into the baseline directory by hand.');
  }
}

export function packagedWorkerMirrorCleanedUp(
  released: boolean,
  downloadRequired: boolean,
  mirror: { readonly requests: number } | undefined,
): boolean {
  return released && (!downloadRequired || (mirror !== undefined && mirror.requests > 0));
}

export interface PackagedJourneyRun {
  readonly mode: PackagedJourneyMode;
  readonly runId: string;
  readonly artifactRoot: string;
  readonly recordVideo: boolean;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

/** Where an acceptance run keeps its artifacts, as the acceptance contract requires. */
export function acceptanceArtifactRoot(workspaceRoot: string, runId: string): string {
  return resolve(workspaceRoot, 'output', 'playwright', 'capture-workbench', runId);
}

/** Where a baseline review run keeps its screenshots, comparisons and evidence. */
export function baselineReviewArtifactRoot(workspaceRoot: string, runId: string): string {
  return resolve(workspaceRoot, 'output', 'playwright', 'capture-workbench-review', runId);
}

export function resolvePackagedJourneyRun(
  environment: NodeJS.ProcessEnv,
  workspaceRoot: string,
): PackagedJourneyRun | undefined {
  const acceptanceRunId = environment.E2E_ACCEPTANCE_RUN_ID?.trim();
  const reviewRunId = environment.E2E_BASELINE_REVIEW_RUN_ID?.trim();
  if (acceptanceRunId && reviewRunId) {
    throw new Error('E2E_ACCEPTANCE_RUN_ID and E2E_BASELINE_REVIEW_RUN_ID exclude each other: a baseline review is never release acceptance.');
  }
  const runId = acceptanceRunId || reviewRunId;
  if (!runId) return undefined;
  const mode: PackagedJourneyMode = acceptanceRunId ? 'acceptance' : 'baseline-review';
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Packaged journey run ID is invalid: ${runId}`);
  }
  const artifactRoot = mode === 'acceptance'
    ? acceptanceArtifactRoot(workspaceRoot, runId)
    : baselineReviewArtifactRoot(workspaceRoot, runId);
  const configured = environment.E2E_ARTIFACT_ROOT?.trim();
  if (configured && resolve(configured).toLowerCase() !== artifactRoot.toLowerCase()) {
    throw new Error(mode === 'acceptance'
      ? 'E2E_ARTIFACT_ROOT must equal output/playwright/capture-workbench/<run-id> in acceptance.'
      : 'E2E_ARTIFACT_ROOT must equal output/playwright/capture-workbench-review/<run-id> in a baseline review.');
  }
  const recordVideo = environment.E2E_RECORD_VIDEO?.trim().toLowerCase();
  if (recordVideo && !['0', '1', 'true', 'false'].includes(recordVideo)) {
    throw new Error('E2E_RECORD_VIDEO must be 0, 1, true, or false.');
  }
  return {
    mode,
    runId,
    artifactRoot,
    recordVideo: recordVideo === '1' || recordVideo === 'true',
  };
}

export interface PackagedJourneyCleanup {
  readonly app: boolean;
  readonly sidecar: boolean;
  readonly cdpPort: boolean;
  readonly runData: boolean;
  readonly workerMirror: boolean;
}

export interface PackagedJourneyProvenance {
  readonly engine: string;
  readonly model: string;
  readonly device: string;
}

export interface PackagedCheckpointComparison {
  readonly name: string;
  readonly outcome: 'matched' | 'differed' | 'baseline missing';
}

export function packagedJourneyVerdict(
  journeyStatus: PackagedJourneyEvidence['status'],
  expectedComparisons: readonly string[],
  comparisons: readonly PackagedCheckpointComparison[],
  cleanup: PackagedJourneyCleanup,
): PackagedJourneyEvidence['status'] {
  return journeyStatus === 'completed'
    && Object.values(cleanup).every(Boolean)
    && comparisons.length === expectedComparisons.length
    && expectedComparisons.every((name) => comparisons.some((entry) => entry.name === name && entry.outcome === 'matched'))
    ? 'completed'
    : 'failed';
}

/**
 * What one journey run proved, without private content: digests, counts,
 * provenance and cleanup, never a file name, path, transcript or text.
 */
export interface PackagedJourneyEvidence {
  readonly evidenceKind: 'packaged-real-engine-journey';
  readonly journey: PackagedJourney;
  readonly mode: PackagedJourneyMode;
  readonly runId: string;
  readonly status: 'completed' | 'failed';
  readonly runtimeSha256: string;
  /** Acceptance only: the runtime candidate the packaged runtime was bound to. */
  readonly candidateId?: string;
  readonly sourceSha256: string;
  /** The checkpoint screenshots taken, in order. */
  readonly screenshots: readonly string[];
  readonly comparisons: readonly PackagedCheckpointComparison[];
  readonly provenance?: PackagedJourneyProvenance;
  readonly cleanup: PackagedJourneyCleanup;
}

export function assertPackagedJourneyEvidence(value: PackagedJourneyEvidence): void {
  assert.equal(value.evidenceKind, 'packaged-real-engine-journey');
  assert.ok(value.journey === 'ocr' || value.journey === 'asr');
  assert.ok(RUN_ID_PATTERN.test(value.runId), 'Packaged journey evidence run ID is invalid.');
  assert.ok(value.status === 'completed' || value.status === 'failed');
  assert.match(value.runtimeSha256, DIGEST_PATTERN);
  assert.match(value.sourceSha256, DIGEST_PATTERN);
  if (value.mode === 'acceptance') {
    assert.match(value.candidateId ?? '', DIGEST_PATTERN, 'Acceptance evidence must name its runtime candidate.');
  } else {
    assert.equal(value.mode, 'baseline-review');
    assert.equal(value.candidateId, undefined, 'Baseline review evidence never names a runtime candidate.');
  }
  for (const name of value.screenshots) {
    assert.match(name, /^[a-z0-9-]+$/u, 'Packaged journey screenshots are named by checkpoint.');
  }
  for (const { name, outcome } of value.comparisons) {
    assert.ok(value.screenshots.includes(name), 'Comparison evidence must name a saved checkpoint.');
    assert.ok(['matched', 'differed', 'baseline missing'].includes(outcome));
  }
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u, 'Packaged journey evidence must not hold a local path.');
  assertRedactedEvidence(value);
}

/** Writes `<journey>-journey-evidence.json` into the run's artifact root. */
export async function writePackagedJourneyEvidence(
  artifactRoot: string,
  evidence: PackagedJourneyEvidence,
): Promise<string> {
  assertPackagedJourneyEvidence(evidence);
  await mkdir(artifactRoot, { recursive: true });
  const path = join(artifactRoot, `${evidence.journey}-journey-evidence.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}

/** The checkpoint name of a screenshot the run saved in its artifact root. */
export function checkpointNameOf(artifactRoot: string, screenshotPath: string): string {
  const name = relative(resolve(artifactRoot), resolve(screenshotPath));
  if (name.includes(sep) || !name.endsWith('.png')) {
    throw new Error('A checkpoint screenshot must sit directly in the run\'s artifact root.');
  }
  return name.slice(0, -'.png'.length);
}
