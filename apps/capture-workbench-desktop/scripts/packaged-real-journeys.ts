// Entry for the real-engine journeys on the packaged Desktop App when they do
// not write the cross-project acceptance manifest:
//
//   --mode baseline-review [--journey ocr|asr]  review-packaged-real-screenshots
//   --mode acceptance --journey asr             acceptance-packaged-real-asr
//
// The OCR journey's acceptance runs through diagnostic-desktop-ocr.ts, which
// also checks that manifest. This entry runs the chosen Playwright specs one
// after the other in one Playwright process, then lists the compared
// checkpoints a reviewer has to look at (an actual image that differed from
// its baseline or had none) and fails when Playwright failed. It never
// writes a baseline: approved images are copied by hand (README).
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { firstValueFrom } from 'rxjs';

import {
  acceptanceArtifactRoot,
  baselineReviewArtifactRoot,
  type PackagedJourney,
  type PackagedJourneyMode,
} from './packaged-journey-run.ts';
import { resolveReviewReleaseDirectory } from './release-worker-mirror.ts';
import { stageRuntime } from './stage-runtime.ts';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const configPath = 'apps/capture-workbench-desktop/playwright.acceptance.config.ts';
const specs: Readonly<Record<PackagedJourney, string>> = {
  ocr: 'apps/capture-workbench-desktop/scripts/real-desktop-ocr-acceptance.spec.ts',
  asr: 'apps/capture-workbench-desktop/scripts/real-desktop-asr-acceptance.spec.ts',
};

export interface PackagedJourneysRequest {
  readonly mode: PackagedJourneyMode;
  readonly journeys: readonly PackagedJourney[];
}

export function parsePackagedJourneysArguments(argv: readonly string[]): PackagedJourneysRequest {
  // Nx forwards `--journey ocr` to the command as `--journey=ocr`.
  const value = (option: string): string | undefined => {
    const joined = argv.find((argument) => argument.startsWith(`${option}=`));
    if (joined !== undefined) return joined.slice(option.length + 1);
    const index = argv.indexOf(option);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const mode = value('--mode');
  if (mode !== 'baseline-review' && mode !== 'acceptance') {
    throw new Error('--mode must be baseline-review or acceptance.');
  }
  const journey = value('--journey');
  const journeys: readonly PackagedJourney[] | undefined = journey === undefined
    ? ['ocr', 'asr']
    : journey === 'ocr' || journey === 'asr' ? [journey] : undefined;
  if (journeys === undefined) {
    throw new Error('--journey must be ocr or asr.');
  }
  if (mode === 'acceptance' && journey !== 'asr') {
    // OCR acceptance also writes and checks the acceptance manifest.
    throw new Error('Acceptance mode here runs the ASR journey only (--journey asr); run diagnostic-desktop-ocr for OCR.');
  }
  return { mode, journeys };
}

/** The inputs each journey reads, checked before anything is launched. */
export function missingJourneyInputs(
  request: PackagedJourneysRequest,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const set = (name: string): boolean => Boolean(environment[name]?.trim());
  const missing: string[] = [];
  if (!set('CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT')) missing.push('CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT');
  if (request.journeys.includes('ocr') && !set('CAPTURE_REAL_DESKTOP_OCR_PDF') && !set('CAPTURE_REAL_DESKTOP_OCR_INPUT')) {
    missing.push('CAPTURE_REAL_DESKTOP_OCR_PDF or CAPTURE_REAL_DESKTOP_OCR_INPUT');
  }
  if (request.journeys.includes('asr') && !set('CAPTURE_REAL_DESKTOP_ASR_RECORDING')) {
    missing.push('CAPTURE_REAL_DESKTOP_ASR_RECORDING');
  }
  if (request.mode === 'acceptance') {
    for (const name of ['CAPTURE_RUNTIME_CANDIDATE_ROOT', 'CAPTURE_RUNTIME_CANDIDATE_ID', 'CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE']) {
      if (!set(name)) missing.push(name);
    }
  }
  return missing;
}

/**
 * The environment of the Playwright run: exactly one of the two run IDs, and
 * the artifact root its mode requires.
 */
export function journeysEnvironment(
  request: PackagedJourneysRequest,
  environment: NodeJS.ProcessEnv,
  runId: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...environment };
  delete next.E2E_ACCEPTANCE_RUN_ID;
  delete next.E2E_BASELINE_REVIEW_RUN_ID;
  if (request.mode === 'baseline-review') {
    next.E2E_BASELINE_REVIEW_RUN_ID = runId;
    next.E2E_ARTIFACT_ROOT = baselineReviewArtifactRoot(workspaceRoot, runId);
    // Acceptance requires DirectML OCR; a review shows the same screens.
    next.CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE ||= 'directml';
  } else {
    next.E2E_ACCEPTANCE_RUN_ID = runId;
    next.E2E_ARTIFACT_ROOT = acceptanceArtifactRoot(workspaceRoot, runId);
  }
  return next;
}

/** Actual images from Playwright diffs or from the journey's missing-baseline capture. */
export async function checkpointsToReview(
  testResults: string,
): Promise<ReadonlyArray<{ readonly name: string; readonly baseline: 'differs' | 'missing'; readonly actual: string }>> {
  const files = await readdir(testResults, { recursive: true }).catch(() => [] as string[]);
  const actual = files.filter((file) => file.endsWith('-actual.png'));
  return actual.map((file) => {
    const name = file.replace(/^.*[\\/]/u, '').replace(/-actual\.png$/u, '');
    const diff = file.replace(/-actual\.png$/u, '-diff.png');
    const baseline: 'differs' | 'missing' = files.includes(diff) ? 'differs' : 'missing';
    return { name, baseline, actual: join(testResults, file) };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function planReviewRelease(environment: NodeJS.ProcessEnv) {
  const directory = resolveReviewReleaseDirectory(workspaceRoot, environment);
  return {
    stage: {
      artifactPath: join(directory, 'capture-runtime-x86_64-pc-windows-msvc.exe'),
      manifestPath: join(directory, 'capture-runtime-manifest.json'),
      schemaPath: join(directory, 'capture-document-v2.schema.json'),
      source: 'release',
    },
    environment: { ...environment, CAPTURE_REAL_DESKTOP_RELEASE_DIR: directory },
  };
}

function runCorepack(args: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(
    'corepack',
    args,
    { cwd: workspaceRoot, env: environment, stdio: 'inherit', shell: true, windowsHide: false },
  );
  return new Promise((resolveStatus) => {
    child.once('error', () => resolveStatus(1));
    child.once('close', (status) => resolveStatus(status ?? 1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const request = parsePackagedJourneysArguments(process.argv.slice(2));
  const missing = missingJourneyInputs(request, process.env);
  if (missing.length > 0) {
    const guidance = missing.includes('CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT')
      ? ' Choose a short folder such as C:\\cwr. Engine workers load only from paths shorter than Windows MAX_PATH.'
      : '';
    throw new Error(`Set ${missing.join(', ')} before running the packaged journeys.${guidance}`);
  }
  const runVariable = request.mode === 'baseline-review' ? 'E2E_BASELINE_REVIEW_RUN_ID' : 'E2E_ACCEPTANCE_RUN_ID';
  const runId = process.env[runVariable]?.trim()
    || `local-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`;
  let environment = journeysEnvironment(request, process.env, runId);
  if (request.mode === 'baseline-review') {
    const release = planReviewRelease(environment);
    await firstValueFrom(stageRuntime(release.stage));
    environment = release.environment;
    const buildStatus = await runCorepack(['pnpm', 'nx', 'run', 'capture-workbench-desktop:build-acceptance'], environment);
    if (buildStatus !== 0) throw new Error('The packaged baseline review build failed.');
  }
  const artifactRoot = String(environment.E2E_ARTIFACT_ROOT);
  const status = await runCorepack(
    ['pnpm', 'exec', 'playwright', 'test', '--config', configPath, ...request.journeys.map((journey) => specs[journey]), '--project=chromium'],
    environment,
  );
  const review = await checkpointsToReview(join(artifactRoot, 'test-results'));
  process.stdout.write(`Packaged journeys (${request.mode}, ${request.journeys.join(' and ')}): ${relative(workspaceRoot, artifactRoot)}\n`);
  for (const checkpoint of review) {
    process.stdout.write(`  ${checkpoint.name}: baseline ${checkpoint.baseline}; actual ${relative(workspaceRoot, checkpoint.actual)}\n`);
  }
  if (status !== 0) {
    process.stdout.write(review.length > 0
      ? 'The run failed; review the listed images and check the Playwright report for any other failures.\n'
      : 'The run failed before or after its screenshots; see the Playwright report.\n');
    process.exitCode = status;
  }
}
