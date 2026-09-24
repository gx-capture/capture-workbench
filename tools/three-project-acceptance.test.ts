import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  acceptanceScopeContractFor,
  buildCaptureWorkbenchAcceptancePlan,
  buildCaptureWorkbenchChildRequest,
  buildAcceptancePlan,
  computeAcceptanceArtifactBindingHash,
  mapAcceptanceExitCode,
  recoverPreparedCaptureScope,
  runCaptureWorkbenchAcceptance,
  runAcceptanceSequence,
  stableAcceptanceArtifactId,
  type AcceptanceChildRequest,
  type AcceptanceCleanupProof,
  type CaptureWorkbenchAcceptancePlan,
  type AcceptanceProjectPlan,
  validateChildManifest,
} from './three-project-acceptance.ts';
// The resolved capture-tools owner runs these synthetic codec tests before the contract package has a project boundary.
// eslint-disable-next-line @nx/enforce-module-boundaries -- D2.3 keeps the existing capture-tools test owner.
import {
  AcceptanceContractCodecError,
  CapabilityReplayError,
  CapabilityUseRegistry,
  canonicalJson,
  decodeAcceptanceChildWire,
  decodeConsumerSemanticResult,
  decodeProducerChildInvocation,
  decodeProducerChildScope,
  sha256Canonical,
  type ExpectedBindingContext,
  type RootBinding,
} from '../packages/capture-acceptance-contract/src/codecs.ts';

const capturePrivateBindings = {
  ocrInput: 'C:\\private\\j49-ocr-input-8f4b2c71e6a90d3f5b7c1e2a4d8f6c9b.pdf',
  executable: 'C:\\private\\j49-executable-3c7a1f9e5d2b8c4a6f0e1d7b9a5c3f8e.exe',
  installerProvenance: 'C:\\private\\j49-installer-provenance-7d2f9a4c6b1e8f3a5c0d7e2b9f6a1c4e.json',
  candidateRoot: 'C:\\private\\j49-runtime-candidate-5e8a1c4f7b2d9e6a0c3f5d8b1e7a4c9f',
  candidateId: 'a73f9c2e6b1d4f80c5e8a2b7d9f36c1e4a6d8b0f2c7e5a9d1b3f6c8e0a4d7b29',
  modelRoot: 'C:\\private\\j49-ocr-model-1a6f3c8e5b9d2f7a4c0e6b1d8f3a5c9e',
} as const;

function validCaptureOnlyEnvironment(): NodeJS.ProcessEnv {
  return {
    CAPTURE_REAL_DESKTOP_OCR_INPUT: capturePrivateBindings.ocrInput,
    CAPTURE_REAL_DESKTOP_EXECUTABLE: capturePrivateBindings.executable,
    CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE: capturePrivateBindings.installerProvenance,
    CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE: 'windowsml-dml',
    CAPTURE_REAL_DESKTOP_TEARDOWN: 'window-close',
    CAPTURE_RUNTIME_CANDIDATE_ROOT: capturePrivateBindings.candidateRoot,
    CAPTURE_RUNTIME_CANDIDATE_ID: capturePrivateBindings.candidateId,
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: '1',
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: capturePrivateBindings.modelRoot,
  };
}

function capturePrivateValues(): readonly string[] {
  return Object.values(capturePrivateBindings);
}

function assertCaptureEnvironmentError(
  error: unknown,
  key: string,
  code: string,
  privateValues: readonly string[] = [],
): boolean {
  assert.ok(error instanceof Error);
  const typed = error as Error & { readonly key?: unknown; readonly code?: unknown };
  assert.equal(typed.key, key);
  assert.equal(typed.code, code);
  assert.match(error.stack ?? '', /three-project-acceptance\.ts/u);
  const stableErrorText = [
    error.message,
    String(error),
    error.stack ?? '',
  ].join('\n');
  for (const privateValue of privateValues) {
    assert.equal(stableErrorText.includes(privateValue), false);
  }
  return true;
}

test('three-project acceptance plan is fixed and sequential', () => {
  const plan = buildAcceptancePlan('C:\\software-dev', 'run-1', true);
  assert.deepEqual(
    plan.map((item) => item.project),
    ['capture-workbench', 'cert-prep', 'law-prep'],
  );
  assert.ok(
    plan.every((item) => item.target.endsWith(':acceptance-real-recorded')),
  );
  assert.ok(
    plan.every((item) =>
      item.artifactRoot.endsWith(`\\${item.project}\\run-1`),
    ),
  );
});

test('normal plan never enables recording', () => {
  const plan = buildAcceptancePlan('C:\\software-dev', 'run-2', false);
  assert.ok(plan.every((item) => item.target.endsWith(':acceptance-real')));
  assert.ok(plan.every((item) => item.environment.E2E_RECORD_VIDEO === '0'));
});

test('three-project online plans scrub local model overrides from every child', () => {
  const previous = {
    optIn: process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN,
    root: process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT,
    sha256: process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256,
    identity: process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY,
  };
  process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN = '1';
  process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT = 'C:\\private-model-root';
  process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256 = 'a'.repeat(64);
  process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY = 'private-identity';
  try {
    const plan = buildAcceptancePlan('C:\\software-dev', 'run-local-scrub', false);
    for (const item of plan) {
      assert.equal(item.environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN, undefined);
      assert.equal(item.environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT, undefined);
      assert.equal(item.environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256, undefined);
      assert.equal(item.environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY, undefined);
    }
  } finally {
    if (previous.optIn === undefined) delete process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN;
    else process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN = previous.optIn;
    if (previous.root === undefined) delete process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT;
    else process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT = previous.root;
    if (previous.sha256 === undefined) delete process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256;
    else process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256 = previous.sha256;
    if (previous.identity === undefined) delete process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY;
    else process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY = previous.identity;
  }
});

test('capture-only plan is typed, validates nine caller bindings, and scrubs inherited private controls', () => {
  const inherited = {
    ...validCaptureOnlyEnvironment(),
    Path: 'C:\\Windows\\System32',
    cApTuRe_PDF_OCR_E2E_JPEG: 'C:\\private\\fixtures\\alias.jpg',
    CAPTURE_REAL_DESKTOP_OCR_PDF: 'C:\\private\\fixtures\\legacy.pdf',
    e2e_acceptance_event_root: 'C:\\private\\events',
    E2E_ACCEPTANCE_UPDATE_SNAPSHOTS: '1',
    E2E_ACCEPTANCE_BASELINE_REVIEWED: '1',
    E2E_ACCEPTANCE_DIAGNOSTICS: '1',
    E2E_ACCEPTANCE_KEEP_APP_DATA: '1',
  };
  const before = { ...inherited };
  const plan = buildCaptureWorkbenchAcceptancePlan(
    'C:\\software-dev\\capture-workbench',
    'capture-run-1',
    true,
    inherited,
  );

  assert.deepEqual(inherited, before);
  assert.equal(plan.project, 'capture-workbench');
  assert.equal(plan.cwd, 'C:\\software-dev\\capture-workbench');
  assert.equal(
    plan.target,
    'apps/capture-workbench-desktop/scripts/acceptance-real.ts',
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(validCaptureOnlyEnvironment()).map(([key]) => [
        key,
        plan.environment[key],
      ]),
    ),
    validCaptureOnlyEnvironment(),
  );
  assert.equal(plan.environment.Path, 'C:\\Windows\\System32');
  assert.equal(plan.environment.cApTuRe_PDF_OCR_E2E_JPEG, undefined);
  assert.equal(plan.environment.CAPTURE_REAL_DESKTOP_OCR_PDF, undefined);
  assert.equal(plan.environment.e2e_acceptance_event_root, undefined);
  assert.equal(plan.environment.E2E_ACCEPTANCE_UPDATE_SNAPSHOTS, undefined);
  assert.equal(plan.environment.E2E_ACCEPTANCE_BASELINE_REVIEWED, undefined);
  assert.equal(plan.environment.E2E_ACCEPTANCE_DIAGNOSTICS, undefined);
  assert.equal(plan.environment.E2E_ACCEPTANCE_KEEP_APP_DATA, undefined);
  assert.equal(plan.environment.E2E_ACCEPTANCE_RUN_ID, 'capture-run-1');
  assert.equal(plan.environment.E2E_RECORD_VIDEO, '0');
  assert.equal(
    plan.environment.E2E_ARTIFACT_ROOT,
    'C:\\software-dev\\capture-workbench\\output\\playwright\\capture-workbench\\capture-run-1',
  );
  assert.equal(
    plan.environment.E2E_ACCEPTANCE_SCOPE_PATH,
    'C:\\software-dev\\capture-workbench\\output\\playwright\\three-projects\\capture-run-1\\scopes\\capture-workbench.json',
  );
});

test('capture-only plan rejects missing, blank, control, and malformed typed bindings without leaking values', () => {
  const cases: readonly [string, string | undefined, string][] = [
    ['CAPTURE_REAL_DESKTOP_OCR_INPUT', undefined, 'missing'],
    ['CAPTURE_REAL_DESKTOP_EXECUTABLE', '   ', 'blank'],
    ['CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE', 'C:\\private\\provenance\0.json', 'control_character'],
    ['CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE', 'windowsml-dml-other', 'invalid'],
    ['CAPTURE_REAL_DESKTOP_TEARDOWN', 'terminate-process', 'invalid'],
    ['CAPTURE_RUNTIME_CANDIDATE_ROOT', 'C:\\private\\candidate\nroot', 'control_character'],
    ['CAPTURE_RUNTIME_CANDIDATE_ID', 'A'.repeat(64), 'invalid'],
    ['CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN', 'true', 'invalid'],
    ['CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT', '', 'blank'],
  ];

  for (const [key, value, code] of cases) {
    const inherited = validCaptureOnlyEnvironment();
    if (value === undefined) delete inherited[key];
    else inherited[key] = value;
    assert.throws(
      () => buildCaptureWorkbenchAcceptancePlan('C:\\software-dev\\capture-workbench', 'capture-run-invalid', false, inherited),
      (error: unknown) =>
        assertCaptureEnvironmentError(
          error,
          key,
          code,
          capturePrivateValues(),
        ),
    );
  }
});

test('capture-only required aliases use case-insensitive equality and reject conflicting values', () => {
  const inherited = validCaptureOnlyEnvironment();
  inherited.capture_real_desktop_ocr_input =
    inherited.CAPTURE_REAL_DESKTOP_OCR_INPUT;
  const sameValuePlan = buildCaptureWorkbenchAcceptancePlan(
    'C:\\software-dev\\capture-workbench',
    'capture-run-duplicate-same',
    false,
    inherited,
  );
  assert.equal(
    sameValuePlan.environment.CAPTURE_REAL_DESKTOP_OCR_INPUT,
    inherited.CAPTURE_REAL_DESKTOP_OCR_INPUT,
  );
  assert.equal(sameValuePlan.environment.capture_real_desktop_ocr_input, undefined);

  inherited.capture_real_desktop_ocr_input =
    'C:\\private\\fixtures\\different-source.pdf';
  assert.throws(
    () =>
      buildCaptureWorkbenchAcceptancePlan(
        'C:\\software-dev\\capture-workbench',
        'capture-run-duplicate-different',
        false,
        inherited,
      ),
    (error: unknown) =>
      assertCaptureEnvironmentError(
        error,
        'CAPTURE_REAL_DESKTOP_OCR_INPUT',
        'duplicate_conflict',
        capturePrivateValues(),
      ),
  );
});

test('capture-only child request is direct Node with no Nx or build command', () => {
  const plan: CaptureWorkbenchAcceptancePlan = {
    project: 'capture-workbench',
    cwd: 'C:\\software-dev\\capture-workbench',
    target: 'apps/capture-workbench-desktop/scripts/acceptance-real.ts',
    artifactRoot: 'C:\\software-dev\\capture-workbench\\output\\capture-run-1',
    scopePath:
      'C:\\software-dev\\capture-workbench\\output\\capture-run-1\\scope.json',
    environment: {
      ...validCaptureOnlyEnvironment(),
      E2E_ACCEPTANCE_RUN_ID: 'capture-run-1',
    },
  };
  const request: AcceptanceChildRequest = buildCaptureWorkbenchChildRequest(
    plan,
    false,
  );

  assert.equal(request.command, process.execPath);
  assert.equal(request.options.cwd, plan.cwd);
  assert.equal(request.options.shell, false);
  assert.equal(request.options.stdio, 'ignore');
  assert.equal(request.options.windowsHide, false);
  assert.equal(request.options.env, plan.environment);
  assert.deepEqual(request.args, [
    'C:\\software-dev\\capture-workbench\\apps\\capture-workbench-desktop\\scripts\\acceptance-real.ts',
  ]);
  assert.equal(request.args.includes('nx'), false);
  assert.equal(request.args.includes('build'), false);
  assert.equal(request.args.includes('--skip-nx-cache'), false);
  const privateValues = capturePrivateValues();
  for (const privateValue of privateValues) {
    assert.equal(request.args.some((arg) => arg.includes(privateValue)), false);
  }
  const recorded = buildCaptureWorkbenchChildRequest(plan, true);
  assert.deepEqual(recorded.args, request.args);
  assert.ok(recorded.args.every((arg) => !arg.includes('models')));
});

test('package exposes a capture-only script without a cache flag or sibling runner', async () => {
  const packageJson = JSON.parse(
    await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, unknown> };
  const command = packageJson.scripts?.['acceptance:capture-workbench'];
  assert.equal(
    command,
    'node tools/three-project-acceptance.ts --capture-workbench-only',
  );
  assert.equal(String(command).includes('--skip-nx-cache'), false);
  assert.equal(String(command).includes('cert-prep'), false);
  assert.equal(String(command).includes('law-prep'), false);
});

test('child manifest validation binds declared artifacts to on-disk bytes', async () => {
  const artifactRoot = await mkdtemp(
    join(tmpdir(), 'three-project-acceptance-'),
  );
  const payload = Buffer.from('screenshot-proof');
  await writeFile(join(artifactRoot, 'checkpoint.png'), payload);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const item = {
    project: 'capture-workbench' as const,
    cwd: artifactRoot,
    target: 'capture-workbench-desktop:acceptance-real',
    artifactRoot,
    scopePath: join(artifactRoot, 'scope.json'),
    environment: {},
  };
  const manifest = {
    schemaVersion: 2,
    project: 'capture-workbench',
    runId: 'run-1',
    status: 'completed',
    recordVideo: false,
    fixture: { name: 'fixture.pdf', sha256: 'a'.repeat(64) },
    cleanup: {
      app: true,
      sidecar: true,
      cdpPort: true,
      temporaryAppData: true,
      ownedPids: true,
      ownedListeners: true,
      ownedWorkers: true,
    },
    errors: [],
    consoleErrors: [],
    pageErrors: [],
    artifacts: [
      {
        kind: 'screenshot',
        path: 'checkpoint.png',
        bytes: payload.length,
        sha256,
      },
    ],
  };
  assert.equal(
    await validateChildManifest(manifest, item, 'run-1', false),
    true,
  );
  assert.equal(
    await validateChildManifest(
      {
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], bytes: payload.length + 1 }],
      },
      item,
      'run-1',
      false,
    ),
    false,
  );
  assert.equal(
    await validateChildManifest(
      { ...manifest, schemaVersion: 1 },
      item,
      'run-1',
      false,
    ),
    false,
  );
  assert.equal(
    await validateChildManifest(
      { ...manifest, cleanup: { ...manifest.cleanup, ownedWorkers: false } },
      item,
      'run-1',
      false,
    ),
    false,
  );
  assert.equal(await validateChildManifest({ ...manifest, cleanup: { ...manifest.cleanup, app: false } }, item, 'run-1', false, false), true);
  for (const complete of [true, false]) assert.equal(await validateChildManifest({ ...manifest, cleanup: { ...manifest.cleanup, extraBoolean: true } }, item, 'run-1', false, complete), false);
});

const cleanCleanup = {
  app: true,
  sidecar: true,
  cdpPort: true,
  temporaryAppData: true,
  ownedPids: true,
  ownedListeners: true,
  ownedWorkers: true,
};

function validScope(
  item: AcceptanceProjectPlan,
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const artifactSha256 = computeAcceptanceArtifactBindingHash(manifest);
  if (!artifactSha256)
    throw new Error('test fixture artifact hash unavailable');
  const artifactId = stableAcceptanceArtifactId(item.project, 'run-1');
  const processRecords = ['root', 'app', 'session', 'sidecar', 'model'].map(
    (role, index) => ({
      pid: 10_001 + index,
      creationTimeUtc: '2026-08-26T00:00:00.000Z',
      executable: `C:\\private\\${item.project}-${role}.exe`,
      role,
      runId: 'run-1',
      artifactId,
    }),
  );
  return {
    schemaVersion: 2,
    project: item.project,
    runId: 'run-1',
    artifactId,
    artifactSha256,
    expected: acceptanceScopeContractFor(item.project),
    status: 'terminal',
    evidenceComplete: true,
    launchAttempted: true,
    processRecords,
    baselineProcessRecords: [
      {
        pid: 20_001,
        creationTimeUtc: '2026-08-26T00:00:00.000Z',
        executable: 'C:\\private\\baseline.exe',
        role: 'baseline',
      },
    ],
    listenerRecords: [
      {
        host: '127.0.0.1',
        port: 45_001,
        protocol: 'tcp',
        role: 'cdp',
        runId: 'run-1',
        artifactId,
        owner: processRecords[2],
      },
      {
        host: '127.0.0.1',
        port: 45_002,
        protocol: 'tcp',
        role: 'runtime',
        runId: 'run-1',
        artifactId,
        owner: processRecords[3],
      },
      {
        host: '127.0.0.1',
        port: 45_003,
        protocol: 'tcp',
        role: 'model',
        runId: 'run-1',
        artifactId,
        owner: processRecords[4],
      },
    ],
    modelPaths: [`C:\\private\\${item.project}-model`],
    appDataPaths: [`C:\\private\\${item.project}-app-data`],
    sessionPaths: [`C:\\private\\${item.project}-session`],
  };
}

async function sequenceFixture(): Promise<{
  plan: AcceptanceProjectPlan[];
  manifests: Map<string, Record<string, unknown> | undefined>;
  screenshot: Buffer;
}> {
  const root = await mkdtemp(join(tmpdir(), 'three-project-sequence-'));
  const projects = ['capture-workbench', 'cert-prep', 'law-prep'] as const;
  const plan = projects.map((project) => {
    const artifactRoot = join(root, project);
    return {
      project,
      cwd: root,
      target: `${project}:acceptance-real`,
      artifactRoot,
      scopePath: join(root, `${project}-scope.json`),
      environment: { E2E_ACCEPTANCE_RUN_ID: 'run-1' },
    };
  });
  const screenshot = Buffer.from('screenshot-proof');
  const manifests = new Map<string, Record<string, unknown> | undefined>();
  for (const item of plan) {
    await mkdir(item.artifactRoot, { recursive: true });
    await writeFile(join(item.artifactRoot, 'checkpoint.png'), screenshot);
    const digest = createHash('sha256').update(screenshot).digest('hex');
    const manifest = {
      schemaVersion: 2,
      project: item.project,
      runId: 'run-1',
      status: 'completed',
      recordVideo: false,
      fixture: { name: 'fixture.pdf', sha256: 'a'.repeat(64) },
      cleanup: { ...cleanCleanup },
      errors: [],
      consoleErrors: [],
      pageErrors: [],
      artifacts: [
        {
          kind: 'screenshot',
          path: 'checkpoint.png',
          bytes: screenshot.length,
          sha256: digest,
        },
      ],
    };
    manifests.set(
      join(item.artifactRoot, 'acceptance-manifest.json'),
      manifest,
    );
    await writeFile(
      item.scopePath,
      `${JSON.stringify(validScope(item, manifest), null, 2)}\n`,
      'utf8',
    );
  }
  return { plan, manifests, screenshot };
}

function cleanProof(): AcceptanceCleanupProof {
  return { cleanup: { ...cleanCleanup }, errors: [], scopeVerified: true };
}

async function runCaptureFixture(
  fixture: Awaited<ReturnType<typeof sequenceFixture>>,
  configure: (
    manifest: Record<string, unknown>,
    scope: Record<string, unknown>,
  ) => {
    readonly manifest: Record<string, unknown>;
    readonly scope: Record<string, unknown>;
  },
  verifyCleanup: () => Promise<AcceptanceCleanupProof> = async () =>
    cleanProof(),
  recordVideo = false,
): Promise<{
  readonly results: Awaited<ReturnType<typeof runCaptureWorkbenchAcceptance>>;
  readonly requests: AcceptanceChildRequest[];
}> {
  const item = fixture.plan[0] as CaptureWorkbenchAcceptancePlan;
  const manifestPath = join(item.artifactRoot, 'acceptance-manifest.json');
  const originalManifest = fixture.manifests.get(manifestPath);
  if (!originalManifest) throw new Error('capture fixture manifest missing');
  const requests: AcceptanceChildRequest[] = [];
  const results = await runCaptureWorkbenchAcceptance(item, 'run-1', recordVideo, {
    spawnDirectChild: async (request) => {
      requests.push(request);
      const prepared = JSON.parse(
        await readFile(item.scopePath, 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(prepared.status, 'prepared');
      assert.equal(prepared.evidenceComplete, false);
      const configured = configure(
        originalManifest,
        validScope(item, originalManifest),
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify(configured.manifest)}\n`,
        'utf8',
      );
      await writeFile(
        item.scopePath,
        `${JSON.stringify(configured.scope)}\n`,
        'utf8',
      );
      return 0;
    },
    readManifest: async (path) =>
      JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>,
    verifyCleanup,
  });
  return { results, requests };
}

test('capture-only runner prepares scope before one direct child and never starts Cert Prep or LAW Prep', async () => {
  const fixture = await sequenceFixture();
  const { results, requests } = await runCaptureFixture(
    fixture,
    (manifest, scope) => ({ manifest, scope }),
  );

  assert.equal(requests.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].project, 'capture-workbench');
  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[0].cleanupVerified, true);
  assert.equal(requests[0].command, process.execPath);
  assert.equal(requests[0].options.shell, false);
  assert.equal(requests[0].args.includes('nx'), false);
  assert.equal(requests[0].args.includes('build'), false);
});

test('capture-only runner forces non-recorded child validation even when requested recorded', async () => {
  const fixture = await sequenceFixture();
  const { results, requests } = await runCaptureFixture(
    fixture,
    (manifest, scope) => ({ manifest, scope }),
    undefined,
    true,
  );

  assert.equal(results[0].exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.env.E2E_RECORD_VIDEO, undefined);
  assert.equal(requests[0].args.includes('--recorded'), false);
});

test('capture-only runner maps success, missing, nonzero, invalid, and cleanup-false outcomes fail closed', () => {
  const base = {
    project: 'capture-workbench',
    status: 'completed',
    artifactId: 'a'.repeat(64),
    exitCode: 0,
    cleanupVerified: true,
    cleanupErrors: [],
  };
  assert.equal(mapAcceptanceExitCode([base]), 0);
  for (const result of [
    { ...base, status: 'missing' },
    { ...base, exitCode: 17 },
    { ...base, status: 'invalid' },
    { ...base, cleanupVerified: false },
  ]) {
    assert.equal(mapAcceptanceExitCode([result]), 1);
  }
  assert.equal(mapAcceptanceExitCode([]), 1);
  assert.equal(mapAcceptanceExitCode([base, base], 2), 0);
});

test('capture-only runner rejects wrong run or artifact binding', async () => {
  const wrongRunFixture = await sequenceFixture();
  const wrongRun = await runCaptureFixture(
    wrongRunFixture,
    (manifest, scope) => ({
      manifest: { ...manifest, runId: 'replayed-run' },
      scope,
    }),
  );
  assert.equal(wrongRun.results[0].status, 'invalid');
  assert.notEqual(mapAcceptanceExitCode(wrongRun.results), 0);

  const wrongArtifactFixture = await sequenceFixture();
  const wrongArtifact = await runCaptureFixture(
    wrongArtifactFixture,
    (manifest, scope) => ({
      manifest,
      scope: { ...scope, artifactSha256: 'b'.repeat(64) },
    }),
  );
  assert.equal(
    wrongArtifact.results[0].errorCode,
    'scope_artifact_hash_mismatch',
  );
  assert.equal(mapAcceptanceExitCode(wrongArtifact.results), 1);
});

test('capture-only runner rejects cleanup residue even with a completed child', async () => {
  const fixture = await sequenceFixture();
  const { results } = await runCaptureFixture(
    fixture,
    (manifest, scope) => ({ manifest, scope }),
    async () => ({
      cleanup: { ...cleanCleanup, ownedPids: false },
      errors: ['owned PID residue remained'],
      scopeVerified: false,
    }),
  );
  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].cleanupVerified, false);
  assert.equal(mapAcceptanceExitCode(results), 1);
});

test('nonzero child with a clean terminal manifest stops before the next model slot', async () => {
  const fixture = await sequenceFixture();
  const started: string[] = [];
  const results = await runAcceptanceSequence(fixture.plan, 'run-1', false, {
    prepareScope: async () => undefined,
    spawnChild: async (item) => {
      started.push(item.project);
      return 17;
    },
    readManifest: async (path) => fixture.manifests.get(path),
    verifyCleanup: async () => cleanProof(),
  });
  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results.length, 1);
  assert.equal(results[0].exitCode, 17);
  assert.equal(results[0].cleanupVerified, true);
});

test('nonzero child with dirty manifest invokes cleanup witness and never starts the next child', async () => {
  const fixture = await sequenceFixture();
  const firstManifestPath = join(
    fixture.plan[0].artifactRoot,
    'acceptance-manifest.json',
  );
  const dirtyManifest = {
    ...fixture.manifests.get(firstManifestPath),
    cleanup: { ...cleanCleanup, ownedWorkers: false },
  };
  fixture.manifests.set(firstManifestPath, dirtyManifest);
  const started: string[] = [];
  let verifierCalls = 0;
  const results = await runAcceptanceSequence(fixture.plan, 'run-1', false, {
    prepareScope: async () => undefined,
    spawnChild: async (item) => {
      started.push(item.project);
      return 9;
    },
    readManifest: async (path) => fixture.manifests.get(path),
    verifyCleanup: async () => {
      verifierCalls += 1;
      return cleanProof();
    },
  });
  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(verifierCalls, 1);
  assert.equal(results[0].cleanupVerified, false);
  assert.equal(results[0].errorCode, 'manifest_acceptance_failed');
  assert.equal(results[0].exitCode, 9);
});

test('missing manifest fails closed even when cleanup proof is clean', async () => {
  const fixture = await sequenceFixture();
  const firstManifestPath = join(
    fixture.plan[0].artifactRoot,
    'acceptance-manifest.json',
  );
  fixture.manifests.set(firstManifestPath, undefined);
  const started: string[] = [];
  const results = await runAcceptanceSequence(fixture.plan, 'run-1', false, {
    prepareScope: async () => undefined,
    spawnChild: async (item) => {
      started.push(item.project);
      return 0;
    },
    readManifest: async (path) => fixture.manifests.get(path),
    verifyCleanup: async () => cleanProof(),
  });
  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results[0].status, 'missing');
  assert.equal(results[0].cleanupVerified, false);
});

test('missing manifest with residue fails closed and never starts the next child', async () => {
  const fixture = await sequenceFixture();
  const firstManifestPath = join(
    fixture.plan[0].artifactRoot,
    'acceptance-manifest.json',
  );
  fixture.manifests.set(firstManifestPath, undefined);
  const started: string[] = [];
  const results = await runAcceptanceSequence(fixture.plan, 'run-1', false, {
    prepareScope: async () => undefined,
    spawnChild: async (item) => {
      started.push(item.project);
      return 0;
    },
    readManifest: async (path) => fixture.manifests.get(path),
    verifyCleanup: async () => ({
      cleanup: { ...cleanCleanup, ownedPids: false },
      errors: ['owned PID residue remained'],
      scopeVerified: false,
    }),
  });
  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results[0].cleanupVerified, false);
  assert.match(results[0].cleanupErrors.join(' '), /owned PID residue/u);
});

test('cleanup verifier errors fail closed and prevent the next child', async () => {
  const fixture = await sequenceFixture();
  const firstManifestPath = join(
    fixture.plan[0].artifactRoot,
    'acceptance-manifest.json',
  );
  fixture.manifests.set(firstManifestPath, undefined);
  const started: string[] = [];
  const results = await runAcceptanceSequence(fixture.plan, 'run-1', false, {
    prepareScope: async () => undefined,
    spawnChild: async (item) => {
      started.push(item.project);
      return 1;
    },
    readManifest: async (path) => fixture.manifests.get(path),
    verifyCleanup: async () => {
      throw new Error('probe unavailable');
    },
  });
  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results[0].cleanupVerified, false);
  assert.match(results[0].cleanupErrors.join(' '), /cleanup_verifier_failed/u);
});

test('privacy-invalid child manifests expose only stable identity and sanitized diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'three-project-privacy-'));
  const item: AcceptanceProjectPlan = {
    project: 'capture-workbench',
    cwd: root,
    target: 'capture-workbench-desktop:acceptance-real',
    artifactRoot: join(root, 'capture-workbench'),
    scopePath: join(root, 'scope.json'),
    environment: { E2E_ACCEPTANCE_RUN_ID: 'run-privacy' },
  };
  await mkdir(item.artifactRoot, { recursive: true });
  await writeFile(
    join(item.artifactRoot, 'acceptance-manifest.json'),
    JSON.stringify({
      project: item.project,
      runId: 'run-privacy',
      status: 'completed',
      rawText: 'PRIVATE_OCR truth',
      token: 'Bearer secret-token',
      artifactPath: '\\\\server\\share\\capture.png',
    }),
    'utf8',
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
    );
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
    );
    return true;
  }) as typeof process.stderr.write;
  let results;
  try {
    results = await runAcceptanceSequence([item], 'run-privacy', false, {
      prepareScope: async () => undefined,
      spawnChild: async () => 0,
      verifyCleanup: async () => cleanProof(),
    });
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const artifactId = stableAcceptanceArtifactId(item.project, 'run-privacy');
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'missing');
  assert.equal(results[0].errorCode, 'manifest_missing_or_invalid');
  assert.equal(results[0].artifactId, artifactId);
  assert.match(artifactId, /^[a-f0-9]{64}$/u);
  const output = [...stdout, ...stderr].join('');
  assert.doesNotMatch(
    output,
    /C:\\Users\\Private|PRIVATE_OCR|Bearer secret-token|acceptance-manifest\.json/u,
  );
  assert.match(
    output,
    new RegExp(
      `repo=${item.project} artifact=${artifactId} code=manifest_privacy_violation`,
      'u',
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(results),
    /C:\\Users\\Private|PRIVATE_OCR|Bearer secret-token/u,
  );
});

test('self-reported clean child without a scope stops before the next project', async () => {
  const fixture = await sequenceFixture();
  await unlink(fixture.plan[0].scopePath);
  const started: string[] = [];
  const results = await runAcceptanceSequence(fixture.plan, 'run-1', false, {
    prepareScope: async () => undefined,
    spawnChild: async (item) => {
      started.push(item.project);
      return 0;
    },
    readManifest: async (path) => fixture.manifests.get(path),
  });

  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results.length, 1);
  assert.equal(results[0].errorCode, 'scope_missing_or_invalid');
  assert.equal(results[0].cleanupVerified, false);
});

test('invalid scope identity stops before the next project starts', async () => {
  const fixture = await sequenceFixture();
  const scope = JSON.parse(
    await readFile(fixture.plan[0].scopePath, 'utf8'),
  ) as { processRecords: Array<Record<string, unknown>> };
  scope.processRecords[1].pid = 0;
  await writeFile(
    fixture.plan[0].scopePath,
    `${JSON.stringify(scope)}\n`,
    'utf8',
  );
  const started: string[] = [];
  const results = await runAcceptanceSequence(
    fixture.plan.slice(0, 2),
    'run-1',
    false,
    {
      prepareScope: async () => undefined,
      spawnChild: async (item) => {
        started.push(item.project);
        return 0;
      },
      readManifest: async (path) => fixture.manifests.get(path),
    },
  );

  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results.length, 1);
  assert.equal(results[0].errorCode, 'scope_process_identity_invalid');
  assert.equal(results[0].cleanupVerified, false);
});

test('hard-terminated Capture child gets terminal evidence without a clean claim', async () => {
  const fixture = await sequenceFixture();
  const scope = JSON.parse(
    await readFile(fixture.plan[0].scopePath, 'utf8'),
  ) as Record<string, unknown>;
  scope.status = 'prepared';
  scope.evidenceComplete = false;
  scope.launchAttempted = true;
  scope.artifactSha256 = null;
  await writeFile(
    fixture.plan[0].scopePath,
    `${JSON.stringify(scope)}\n`,
    'utf8',
  );
  const manifestPath = join(
    fixture.plan[0].artifactRoot,
    'acceptance-manifest.json',
  );
  const manifest = fixture.manifests.get(manifestPath);
  const started: string[] = [];
  const results = await runAcceptanceSequence(fixture.plan, 'run-1', false, {
    prepareScope: async () => undefined,
    spawnChild: async (item) => {
      started.push(item.project);
      return 137;
    },
    readManifest: async (path) => fixture.manifests.get(path),
    verifyCleanup: async () => cleanProof(),
  });

  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results.length, 1);
  assert.equal(results[0].cleanupVerified, false);
  assert.equal(results[0].errorCode, 'scope_not_terminal_or_complete');
  const recovered = JSON.parse(
    await readFile(fixture.plan[0].scopePath, 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(recovered.status, 'terminal');
  assert.equal(recovered.evidenceComplete, false);
  assert.equal(
    recovered.artifactSha256,
    computeAcceptanceArtifactBindingHash(manifest),
  );
});

test('prepared scope recovery rejects a replayed or unlaunched scope', async () => {
  const fixture = await sequenceFixture();
  const scope = JSON.parse(
    await readFile(fixture.plan[0].scopePath, 'utf8'),
  ) as Record<string, unknown>;
  scope.status = 'prepared';
  scope.evidenceComplete = false;
  scope.launchAttempted = false;
  scope.artifactSha256 = null;
  await writeFile(
    fixture.plan[0].scopePath,
    `${JSON.stringify(scope)}\n`,
    'utf8',
  );
  const manifest = fixture.manifests.get(
    join(fixture.plan[0].artifactRoot, 'acceptance-manifest.json'),
  );
  assert.equal(
    await recoverPreparedCaptureScope(fixture.plan[0], manifest),
    false,
  );
  const unchanged = JSON.parse(
    await readFile(fixture.plan[0].scopePath, 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(unchanged.status, 'prepared');
  assert.equal(unchanged.evidenceComplete, false);
});

const contractDigest = 'a'.repeat(64);

function syntheticRootBinding(ordinal: number): RootBinding {
  return {
    ordinal,
    role: ordinal === 0 ? 'capture' : 'python',
    rootRefDigest: `${String.fromCharCode(98 + ordinal)}${'b'.repeat(63)}`,
    rootGeneration: ordinal + 1,
    specDigest: `${String.fromCharCode(99 + ordinal)}${'c'.repeat(63)}`,
    reservedListenerIdentity: `listener-${ordinal}`,
  };
}

function syntheticFixtureAssignment(): Record<string, unknown> {
  const withoutIdentity = {
    fixtureIndex: 0,
    fixtureKey: 'capture-private-jpeg-1',
    mediaKind: 'jpeg',
    page: null,
    mediaCapabilityHandle: 'media-handle-1',
    mediaCapabilityHandleSha256: 'e'.repeat(64),
    oracleCapabilityHandle: 'oracle-handle-1',
    oracleCapabilityHandleSha256: 'f'.repeat(64),
    mediaSha256: '1'.repeat(64),
    oracleSha256: '2'.repeat(64),
    expectedNormalizedTruthSha256: '3'.repeat(64),
    expectedAnchorSetSha256: '4'.repeat(64),
    cerThreshold: 0.03,
    artifactId: '5'.repeat(64),
  };
  return {
    ...withoutIdentity,
    fixtureIdentitySha256: sha256Canonical(withoutIdentity),
  };
}

function syntheticPlannedScope(): Record<string, unknown> {
  return {
    schemaVersion: 'ProducerChildScopeV1',
    contractVersion: '1',
    contractSha256: contractDigest,
    producer: 'capture-runtime',
    parentGate: 'D4',
    tier: 'candidate',
    runIdDigest: '6'.repeat(64),
    sequenceIndex: 1,
    childKey: 'capture-private-jpeg',
    legId: 'capture-private-jpeg-v1',
    childId: '7'.repeat(64),
    childPlanDigest: '8'.repeat(64),
    readyState: 'planned',
    binding: { kind: 'unbound' },
  };
}

function syntheticInvocationWithoutDigest(): Record<string, unknown> {
  return {
    schemaVersion: 'ProducerChildInvocationV1',
    contractVersion: '1',
    contractSha256: contractDigest,
    producer: 'capture-runtime',
    parentGate: 'D4',
    tier: 'candidate',
    invocationState: 'frozen',
    sequenceIndex: 1,
    childKey: 'capture-private-jpeg',
    legId: 'capture-private-jpeg-v1',
    childId: '7'.repeat(64),
    root: '9'.repeat(64),
    groupRefDigest: 'a'.repeat(64),
    groupGeneration: 1,
    bindingAttemptId: 'binding-attempt-1',
    rootBindings: [syntheticRootBinding(0), syntheticRootBinding(1)],
    activationReceiptDigest: 'b'.repeat(64),
    artifactIds: ['5'.repeat(64)],
    ledgerBinding: {
      sourceGate: 'D3',
      ledgerSha256: 'c'.repeat(64),
      candidateId: 'd'.repeat(64),
      candidateManifestSha256: 'e'.repeat(64),
    },
    predecessorCleanupProofSha256: null,
    fixtureAssignments: [syntheticFixtureAssignment()],
    outputPathNonce: 'output-nonce-1',
  };
}

function syntheticSemanticWithoutDigest(): Record<string, unknown> {
  const assignment = syntheticFixtureAssignment();
  const semanticAssignment = Object.fromEntries(
    Object.entries(assignment).filter(
      ([key]) => key !== 'mediaCapabilityHandle' && key !== 'oracleCapabilityHandle',
    ),
  );
  return {
    schemaVersion: 'ConsumerSemanticResultV1',
    contractVersion: '1',
    contractSha256: contractDigest,
    consumer: 'cert-or-law-adapter',
    parentGate: 'D4',
    tier: 'candidate',
    sequenceIndex: 1,
    childKey: 'capture-private-jpeg',
    legId: 'capture-private-jpeg-v1',
    childId: '7'.repeat(64),
    artifactIds: ['5'.repeat(64)],
    fixtureResults: [
      {
        ...semanticAssignment,
        mediaCapabilityHandleSha256: 'e'.repeat(64),
        oracleCapabilityHandleSha256: 'f'.repeat(64),
        mediaSha256: '1'.repeat(64),
        oracleSha256: '2'.repeat(64),
        actualNormalizedOutputSha256: '3'.repeat(64),
        expectedNormalizedTruthSha256: '3'.repeat(64),
        expectedAnchorSetSha256: '4'.repeat(64),
        cer: 0,
        anchorOmissions: 0,
        cerThreshold: 0.03,
        outcome: 'passed',
        projectionSha256: '6'.repeat(64),
        artifactId: '5'.repeat(64),
      },
    ],
  };
}

function syntheticWireWithoutDigest(
  wireResult: Record<string, unknown>,
  semanticResultSha256: string,
): Record<string, unknown> {
  return {
    schemaVersion: 'AcceptanceChildWireV1',
    contractVersion: '1',
    contractSha256: contractDigest,
    producer: 'capture-runtime',
    parentGate: 'D4',
    tier: 'candidate',
    runIdDigest: '6'.repeat(64),
    sequenceIndex: 1,
    childKey: 'capture-private-jpeg',
    legId: 'capture-private-jpeg-v1',
    childId: '7'.repeat(64),
    root: '9'.repeat(64),
    artifactIds: ['5'.repeat(64)],
    ledgerBinding: wireLedger(),
    invocationSha256: 'c'.repeat(64),
    fixtureAssignments: [syntheticFixtureAssignment()],
    fixtureResults: [wireResult],
    childSemanticResultSha256: semanticResultSha256,
    producerCleanup: {
      journalState: 'terminal',
      reconcileRefSha256: '1'.repeat(64),
      generation: 1,
      automaticAttempts: 1,
      rootReaped: true,
      descendantsTerminated: true,
      listenersReleased: true,
      stagingReleased: true,
      captureDeleted: true,
      modelMemoryReleased: true,
      processesAbsent: true,
      listenersAbsent: true,
      stagingAbsent: true,
      proofSha256: '2'.repeat(64),
    },
    privacy: {
      rawOcr: false,
      rawTruth: false,
      rawMedia: false,
      tokens: false,
      paths: false,
      nativeIds: false,
    },
  };
}

test('acceptance schema documents keep each record boundary closed', async () => {
  const schemaRoot = join(process.cwd(), 'packages', 'capture-acceptance-contract', 'schemas');
  const schemaNames = [
    'producer-child-scope-v1.schema.json',
    'producer-child-invocation-v1.schema.json',
    'consumer-semantic-result-v1.schema.json',
    'acceptance-child-wire-v1.schema.json',
  ] as const;
  for (const schemaName of schemaNames) {
    const schema = JSON.parse(await readFile(join(schemaRoot, schemaName), 'utf8')) as {
      title?: unknown;
      oneOf?: readonly unknown[];
      additionalProperties?: unknown;
      $defs?: Record<string, { unevaluatedProperties?: unknown }>;
    };
    assert.equal(typeof schema.title, 'string');
    if (schemaName === 'producer-child-scope-v1.schema.json') {
      assert.equal(schema.oneOf?.length, 3);
      assert.ok(schema.$defs);
      for (const variant of ['planned', 'prepared', 'ready']) {
        assert.equal(schema.$defs[variant]?.unevaluatedProperties, false);
      }
    } else {
      assert.equal(schema.additionalProperties, false);
    }
  }
});

type StrictValidator = ((value: unknown) => boolean) & { errors?: readonly unknown[] | null };
type StrictAjv = { compile(schema: unknown): StrictValidator };
type ContractSchemaName =
  | 'producer-child-scope-v1.schema.json'
  | 'producer-child-invocation-v1.schema.json'
  | 'consumer-semantic-result-v1.schema.json'
  | 'acceptance-child-wire-v1.schema.json';

function strictAjv2020(): StrictAjv {
  return new Ajv2020({ strict: true, allErrors: true }) as unknown as StrictAjv;
}

function decodeSharedContractVector(
  schemaName: ContractSchemaName,
  value: Record<string, unknown>,
  expectedBinding: ExpectedBindingContext,
): unknown {
  switch (schemaName) {
    case 'producer-child-scope-v1.schema.json':
      return decodeProducerChildScope(canonicalJson(value), expectedBinding);
    case 'producer-child-invocation-v1.schema.json':
      return decodeProducerChildInvocation(canonicalJson(value), expectedBinding);
    case 'consumer-semantic-result-v1.schema.json':
      return decodeConsumerSemanticResult(canonicalJson(value));
    case 'acceptance-child-wire-v1.schema.json':
      return decodeAcceptanceChildWire(canonicalJson(value));
  }
}

test('strict Ajv 2020 and codecs agree on shared structural vectors', async () => {
  const schemaRoot = join(process.cwd(), 'packages', 'capture-acceptance-contract', 'schemas');
  const schemaNames = [
    'producer-child-scope-v1.schema.json',
    'producer-child-invocation-v1.schema.json',
    'consumer-semantic-result-v1.schema.json',
    'acceptance-child-wire-v1.schema.json',
  ] as const;
  const ajv = strictAjv2020();
  const validators = new Map(
    await Promise.all(
      schemaNames.map(async (schemaName) => {
        const schema = JSON.parse(
          await readFile(join(schemaRoot, schemaName), 'utf8'),
        ) as Record<string, unknown>;
        return [schemaName, ajv.compile(schema)] as const;
      }),
    ),
  );
  const expectedBinding = syntheticExpectedBinding();
  const planned = syntheticPlannedScope();
  const prepared = {
    ...planned,
    readyState: 'prepared',
    binding: { kind: 'bound', ...expectedBinding },
  };
  const invocationWithoutDigest = syntheticInvocationWithoutDigest();
  const invocation: Record<string, unknown> = {
    ...invocationWithoutDigest,
    invocationSha256: sha256Canonical(invocationWithoutDigest),
  };
  const semanticWithoutDigest = syntheticSemanticWithoutDigest();
  const semantic: Record<string, unknown> = {
    ...semanticWithoutDigest,
    semanticResultSha256: sha256Canonical(semanticWithoutDigest),
  };
  const wireResult = {
    ...(semanticWithoutDigest.fixtureResults as Array<Record<string, unknown>>)[0],
    normalization: 'nfkc-whitespace-v1',
    distance: 'code-point-levenshtein-v1',
  };
  const wireWithoutDigest = syntheticWireWithoutDigest(
    wireResult,
    semantic.semanticResultSha256 as string,
  );
  const wire: Record<string, unknown> = {
    ...wireWithoutDigest,
    wireSha256: sha256Canonical(wireWithoutDigest),
  };
  const ready = {
    ...prepared,
    readyState: 'ready',
    invocationSha256: 'c'.repeat(64),
    outputPathNonce: 'output-nonce-1',
  };
  const scopeNestedUnknown = {
    ...planned,
    binding: { kind: 'unbound', unexpected: true },
  };
  const scopeMissingRequired = { ...planned };
  delete scopeMissingRequired.childPlanDigest;
  const invocationNestedUnknown = {
    ...invocation,
    ledgerBinding: {
      ...(invocation.ledgerBinding as Record<string, unknown>),
      unexpected: true,
    },
  };
  const invocationMissingRequired = { ...invocation };
  delete invocationMissingRequired.outputPathNonce;
  const semanticResult = (semantic.fixtureResults as Array<Record<string, unknown>>)[0];
  const semanticNestedUnknown = {
    ...semantic,
    fixtureResults: [{ ...semanticResult, unexpected: true }],
  };
  const semanticMissingRequired = { ...semantic };
  delete semanticMissingRequired.fixtureResults;
  const wireNestedUnknown = {
    ...wire,
    privacy: { ...(wire.privacy as Record<string, unknown>), unexpected: true },
  };
  const wireMissingRequired = { ...wire };
  delete wireMissingRequired.privacy;
  // Structural rows are validated identically by strict Ajv and each public decoder.
  // Gate/tier rows deliberately remain schema-valid: the relation is a codec-only
  // check because JSON Schema expresses the two enum domains but not their pairing.
  const sharedVectors: readonly [ContractSchemaName, Record<string, unknown>, boolean, boolean][] = [
    ['producer-child-scope-v1.schema.json', planned, true, true],
    ['producer-child-scope-v1.schema.json', prepared, true, true],
    ['producer-child-scope-v1.schema.json', ready, true, true],
    ['producer-child-scope-v1.schema.json', scopeMissingRequired, false, false],
    ['producer-child-scope-v1.schema.json', scopeNestedUnknown, false, false],
    ['producer-child-scope-v1.schema.json', { ...planned, sequenceIndex: '1' }, false, false],
    [
      'producer-child-scope-v1.schema.json',
      { ...ready, binding: { kind: 'unbound' } },
      false,
      false,
    ],
    ['producer-child-scope-v1.schema.json', { ...planned, parentGate: 'D7' }, true, false],
    ['producer-child-invocation-v1.schema.json', invocation, true, true],
    ['producer-child-invocation-v1.schema.json', invocationMissingRequired, false, false],
    ['producer-child-invocation-v1.schema.json', invocationNestedUnknown, false, false],
    [
      'producer-child-invocation-v1.schema.json',
      { ...invocation, groupGeneration: '1' },
      false,
      false,
    ],
    ['producer-child-invocation-v1.schema.json', { ...invocation, parentGate: 'D7' }, true, false],
    ['consumer-semantic-result-v1.schema.json', semantic, true, true],
    ['consumer-semantic-result-v1.schema.json', semanticMissingRequired, false, false],
    ['consumer-semantic-result-v1.schema.json', semanticNestedUnknown, false, false],
    ['consumer-semantic-result-v1.schema.json', { ...semantic, sequenceIndex: '1' }, false, false],
    ['consumer-semantic-result-v1.schema.json', { ...semantic, parentGate: 'D7' }, true, false],
    ['acceptance-child-wire-v1.schema.json', wire, true, true],
    ['acceptance-child-wire-v1.schema.json', wireMissingRequired, false, false],
    ['acceptance-child-wire-v1.schema.json', wireNestedUnknown, false, false],
    ['acceptance-child-wire-v1.schema.json', { ...wire, sequenceIndex: '1' }, false, false],
    ['acceptance-child-wire-v1.schema.json', { ...wire, parentGate: 'D7' }, true, false],
  ];
  for (const [schemaName, value, schemaValid, codecValid] of sharedVectors) {
    const validator = validators.get(schemaName);
    assert.ok(validator);
    assert.equal(validator(value), schemaValid, `${schemaName}: ${JSON.stringify(validator.errors)}`);
    if (codecValid) {
      assert.doesNotThrow(() => decodeSharedContractVector(schemaName, value, expectedBinding));
    } else {
      assert.throws(
        () => decodeSharedContractVector(schemaName, value, expectedBinding),
        AcceptanceContractCodecError,
      );
    }
  }
  assert.equal(decodeProducerChildScope(canonicalJson(prepared), expectedBinding).readyState, 'prepared');
  assert.equal(decodeProducerChildScope(canonicalJson(ready), expectedBinding).readyState, 'ready');
  assert.equal(decodeProducerChildInvocation(canonicalJson(invocation), expectedBinding).invocationState, 'frozen');
  assert.equal(decodeConsumerSemanticResult(canonicalJson(semantic)).fixtureResults.length, 1);
  assert.equal(decodeAcceptanceChildWire(canonicalJson(wire)).fixtureResults.length, 1);
});

test('canonical codecs reject non-JSON values, cycles, BOMs, and invalid UTF-8', () => {
  const getter = {} as { value?: number };
  Object.defineProperty(getter, 'value', { enumerable: true, get: () => 1 });
  const sparse: unknown[] = [];
  sparse.length = 1;
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(new Date()), AcceptanceContractCodecError);
  assert.throws(() => canonicalJson(getter), AcceptanceContractCodecError);
  assert.throws(() => canonicalJson(sparse), AcceptanceContractCodecError);
  assert.throws(() => canonicalJson(cycle), AcceptanceContractCodecError);
  const plannedText = canonicalJson(syntheticPlannedScope());
  assert.throws(
    () => decodeProducerChildScope(new TextEncoder().encode(`\uFEFF${plannedText}`)),
    /BOM/u,
  );
  assert.throws(
    () => decodeProducerChildScope(new Uint8Array([0xff, 0xfe, 0xfd])),
    /UTF-8/u,
  );
});

// These relational checks are intentionally codec-only: the JSON Schemas close each
// record structurally, while the codec owns expected binding context, self-digests,
// ordered root/fixture identity, gate/ledger pairing, and capability consumption.
test('acceptance schemas and codecs close state, binding, and capability boundaries', () => {
  const expectedBinding = syntheticExpectedBinding();
  const planned = syntheticPlannedScope();
  assert.deepEqual(
    decodeProducerChildScope(canonicalJson(planned)).readyState,
    'planned',
  );
  assert.throws(
    () => decodeProducerChildScope(canonicalJson({ ...planned, unknownField: true })),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeProducerChildScope(
        canonicalJson({ ...planned, binding: { kind: 'unbound', rootBindings: [] } }),
      ),
    AcceptanceContractCodecError,
  );
  const prepared = {
    ...planned,
    readyState: 'prepared',
    binding: {
      kind: 'bound',
      bindingAttemptId: 'binding-attempt-1',
      groupRefDigest: 'a'.repeat(64),
      groupGeneration: 1,
      rootBindings: [syntheticRootBinding(0), syntheticRootBinding(1)],
      activationReceiptDigest: 'b'.repeat(64),
    },
  };
  assert.throws(
    () => decodeProducerChildScope(canonicalJson(prepared)),
    AcceptanceContractCodecError,
  );
  assert.equal(
    decodeProducerChildScope(canonicalJson(prepared), expectedBinding).readyState,
    'prepared',
  );
  assert.throws(
    () =>
      decodeProducerChildScope(
        canonicalJson({
          ...prepared,
          binding: { ...prepared.binding, rootBindings: [syntheticRootBinding(0)] },
        }),
        expectedBinding,
      ),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeProducerChildScope(
        canonicalJson({
          ...prepared,
          binding: {
            ...prepared.binding,
            rootBindings: [
              { ...syntheticRootBinding(0), rootGeneration: 99 },
              syntheticRootBinding(1),
            ],
          },
        }),
        expectedBinding,
      ),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeProducerChildScope(
        canonicalJson({
          ...prepared,
          binding: { ...prepared.binding, rootBindings: [syntheticRootBinding(0), syntheticRootBinding(2)] },
        }),
      ),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeProducerChildScope(
        canonicalJson({
          ...prepared,
          binding: {
            ...prepared.binding,
            rootBindings: [syntheticRootBinding(1), syntheticRootBinding(0)],
          },
        }),
        expectedBinding,
      ),
    AcceptanceContractCodecError,
  );

  const ready = {
    ...prepared,
    readyState: 'ready',
    invocationSha256: 'c'.repeat(64),
    outputPathNonce: 'output-nonce-1',
  };
  const invocationWithoutDigest = syntheticInvocationWithoutDigest();
  const invocation = {
    ...invocationWithoutDigest,
    invocationSha256: sha256Canonical(invocationWithoutDigest),
  };
  assert.equal(
    decodeProducerChildInvocation(canonicalJson(invocation), expectedBinding).invocationState,
    'frozen',
  );
  assert.throws(
    () => {
      const truncatedInvocation = { ...invocation, rootBindings: [syntheticRootBinding(0)] };
      const truncatedWithoutDigest: Record<string, unknown> = { ...truncatedInvocation };
      delete truncatedWithoutDigest.invocationSha256;
      decodeProducerChildInvocation(
        canonicalJson({
          ...truncatedWithoutDigest,
          invocationSha256: sha256Canonical(truncatedWithoutDigest),
        }),
        expectedBinding,
      );
    },
    AcceptanceContractCodecError,
  );
  assert.throws(
    () => {
      const reorderedInvocation = {
        ...invocation,
        rootBindings: [syntheticRootBinding(1), syntheticRootBinding(0)],
      };
      const reorderedWithoutDigest: Record<string, unknown> = { ...reorderedInvocation };
      delete reorderedWithoutDigest.invocationSha256;
      decodeProducerChildInvocation(
        canonicalJson({
          ...reorderedWithoutDigest,
          invocationSha256: sha256Canonical(reorderedWithoutDigest),
        }),
        expectedBinding,
      );
    },
    AcceptanceContractCodecError,
  );
  const substitutedInvocation = {
    ...invocation,
    rootBindings: [
      { ...syntheticRootBinding(0), rootGeneration: 99 },
      syntheticRootBinding(1),
    ],
  };
  assert.throws(
    () => {
      const substitutedWithoutDigest: Record<string, unknown> = { ...substitutedInvocation };
      delete substitutedWithoutDigest.invocationSha256;
      decodeProducerChildInvocation(
        canonicalJson({
          ...substitutedWithoutDigest,
          invocationSha256: sha256Canonical(substitutedWithoutDigest),
        }),
        expectedBinding,
      );
    },
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeProducerChildInvocation(canonicalJson({ ...invocation, scope: ready }), expectedBinding),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () => decodeProducerChildInvocation(JSON.stringify(invocation), expectedBinding),
    /canonical/u,
  );

  const capabilities = new CapabilityUseRegistry();
  const capabilityContext = {
    childId: '7'.repeat(64),
    legId: 'capture-private-jpeg-v1',
    parentGate: 'D4' as const,
    invocationSha256: 'c'.repeat(64),
  };
  capabilities.issue('e'.repeat(64), capabilityContext);
  assert.throws(
    () => capabilities.consume('e'.repeat(64), { ...capabilityContext, legId: 'other-leg' }),
    AcceptanceContractCodecError,
  );
  capabilities.consume('e'.repeat(64), capabilityContext);
  assert.equal(capabilities.isConsumed('e'.repeat(64), capabilityContext), true);
  assert.throws(
    () => capabilities.consume('e'.repeat(64), capabilityContext),
    CapabilityReplayError,
  );
  assert.throws(
    () => capabilities.consume('f'.repeat(64), capabilityContext),
    AcceptanceContractCodecError,
  );
});

function syntheticExpectedBinding(): ExpectedBindingContext {
  return {
    bindingAttemptId: 'binding-attempt-1',
    groupRefDigest: 'a'.repeat(64),
    groupGeneration: 1,
    rootBindings: [syntheticRootBinding(0), syntheticRootBinding(1)],
    activationReceiptDigest: 'b'.repeat(64),
  };
}

test('semantic and wire codecs reject consumer-owned cleanup fields and preserve ordered results', () => {
  const semanticWithoutDigest = syntheticSemanticWithoutDigest();
  const semantic = {
    ...semanticWithoutDigest,
    semanticResultSha256: sha256Canonical(semanticWithoutDigest),
  };
  const decoded = decodeConsumerSemanticResult(canonicalJson(semantic));
  assert.equal(decoded.fixtureResults[0].fixtureKey, 'capture-private-jpeg-1');
  assert.throws(
    () =>
      decodeConsumerSemanticResult(
        canonicalJson({ ...semantic, producerCleanup: { journalState: 'terminal' } }),
      ),
    AcceptanceContractCodecError,
  );

  const wireResult = {
    ...(semanticWithoutDigest.fixtureResults as Array<Record<string, unknown>>)[0],
    normalization: 'nfkc-whitespace-v1',
    distance: 'code-point-levenshtein-v1',
  };
  const wireWithoutDigest = syntheticWireWithoutDigest(wireResult, semantic.semanticResultSha256 as string);
  const wire = { ...wireWithoutDigest, wireSha256: sha256Canonical(wireWithoutDigest) };
  assert.equal(decodeAcceptanceChildWire(canonicalJson(wire)).privacy.paths, false);
  for (const [field, value] of [
    ['fixtureIndex', 1],
    ['fixtureKey', 'other-fixture'],
    ['fixtureIdentitySha256', '0'.repeat(64)],
    ['mediaKind', 'pdf'],
    ['page', 1],
    ['mediaCapabilityHandleSha256', 'a'.repeat(64)],
    ['oracleCapabilityHandleSha256', 'b'.repeat(64)],
    ['mediaSha256', '0'.repeat(64)],
    ['oracleSha256', 'c'.repeat(64)],
    ['expectedNormalizedTruthSha256', 'd'.repeat(64)],
    ['expectedAnchorSetSha256', 'e'.repeat(64)],
    ['cerThreshold', 0.02],
    ['artifactId', 'f'.repeat(64)],
  ] as const) {
    const mutatedWithoutDigest = {
      ...wireWithoutDigest,
      fixtureResults: [{ ...wireResult, [field]: value }],
    };
    assert.throws(
      () =>
        decodeAcceptanceChildWire(
          canonicalJson({
            ...mutatedWithoutDigest,
            wireSha256: sha256Canonical(mutatedWithoutDigest),
          }),
        ),
      AcceptanceContractCodecError,
    );
  }
  assert.throws(
    () => decodeAcceptanceChildWire(canonicalJson({ ...wire, consumerCleanup: true })),
    AcceptanceContractCodecError,
  );
});

test('semantic codecs enforce fixed OCR thresholds and measurement outcomes', () => {
  const base = syntheticSemanticWithoutDigest();
  const baseResult = (base.fixtureResults as Array<Record<string, unknown>>)[0];
  const semanticWith = (overrides: Record<string, unknown>): Record<string, unknown> => {
    const body = {
      ...base,
      fixtureResults: [{ ...baseResult, ...overrides }],
    };
    return { ...body, semanticResultSha256: sha256Canonical(body) };
  };

  assert.throws(
    () =>
      decodeConsumerSemanticResult(
        canonicalJson(semanticWith({ cerThreshold: 0.99 })),
      ),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeConsumerSemanticResult(
        canonicalJson(
          semanticWith({
            actualNormalizedOutputSha256: 'a'.repeat(64),
            cer: 0.04,
            outcome: 'passed',
          }),
        ),
      ),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeConsumerSemanticResult(
        canonicalJson(semanticWith({ outcome: 'failed' })),
      ),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeConsumerSemanticResult(
        canonicalJson(
          semanticWith({ actualNormalizedOutputSha256: 'a'.repeat(64), cer: 0 }),
        ),
      ),
    AcceptanceContractCodecError,
  );
  assert.throws(
    () =>
      decodeConsumerSemanticResult(
        canonicalJson(semanticWith({ cer: 0.01 })),
      ),
    AcceptanceContractCodecError,
  );
  assert.doesNotThrow(() =>
    decodeConsumerSemanticResult(
      canonicalJson(
        semanticWith({
          actualNormalizedOutputSha256: 'a'.repeat(64),
          cer: 2,
          outcome: 'failed',
        }),
      ),
    ),
  );

  const pdfSemanticWith = (overrides: Record<string, unknown>): Record<string, unknown> => {
    const body = {
      ...base,
      fixtureResults: [
        {
          ...baseResult,
          mediaKind: 'pdf',
          page: 2,
          cerThreshold: 0.01,
          ...overrides,
        },
      ],
    };
    return { ...body, semanticResultSha256: sha256Canonical(body) };
  };
  assert.throws(
    () =>
      decodeConsumerSemanticResult(
        canonicalJson(pdfSemanticWith({ cerThreshold: 0.99 })),
      ),
    AcceptanceContractCodecError,
  );
  assert.doesNotThrow(() =>
    decodeConsumerSemanticResult(
      canonicalJson(
        pdfSemanticWith({
          actualNormalizedOutputSha256: 'a'.repeat(64),
          cer: 0.005,
          outcome: 'passed',
        }),
      ),
    ),
  );
});

test('acceptance schemas encode fixed thresholds and allow finite CER above one', async () => {
  const schemaRoot = join(process.cwd(), 'packages', 'capture-acceptance-contract', 'schemas');
  const ajv = strictAjv2020();
  const semanticSchema = JSON.parse(
    await readFile(join(schemaRoot, 'consumer-semantic-result-v1.schema.json'), 'utf8'),
  );
  const wireSchema = JSON.parse(
    await readFile(join(schemaRoot, 'acceptance-child-wire-v1.schema.json'), 'utf8'),
  );
  const semanticValidator = ajv.compile(semanticSchema);
  const wireValidator = ajv.compile(wireSchema);
  const base = syntheticSemanticWithoutDigest();
  const baseResult = (base.fixtureResults as Array<Record<string, unknown>>)[0];
  const semanticWith = (overrides: Record<string, unknown>): Record<string, unknown> => {
    const body = {
      ...base,
      fixtureResults: [{ ...baseResult, ...overrides }],
    };
    return { ...body, semanticResultSha256: sha256Canonical(body) };
  };

  assert.equal(
    semanticValidator(semanticWith({
      actualNormalizedOutputSha256: 'a'.repeat(64),
      cer: 2,
      outcome: 'failed',
    })),
    true,
  );
  assert.equal(
    semanticValidator(
      semanticWith({
        actualNormalizedOutputSha256: 'a'.repeat(64),
        cer: 0.04,
        outcome: 'passed',
      }),
    ),
    false,
  );
  assert.equal(semanticValidator(semanticWith({ outcome: 'failed' })), false);

  const wireResult = {
    ...baseResult,
    normalization: 'nfkc-whitespace-v1',
    distance: 'code-point-levenshtein-v1',
  };
  const wireWithoutDigest = syntheticWireWithoutDigest(wireResult, 'a'.repeat(64));
  const wire = {
    ...wireWithoutDigest,
    wireSha256: sha256Canonical(wireWithoutDigest),
  };
  assert.equal(
    wireValidator({
      ...wire,
      fixtureResults: [
        {
          ...wireResult,
          actualNormalizedOutputSha256: 'a'.repeat(64),
          cer: 2,
          outcome: 'failed',
        },
      ],
    }),
    true,
  );
  assert.equal(
    wireValidator({
      ...wire,
      fixtureResults: [{ ...wireResult, cerThreshold: 0.99 }],
    }),
    false,
  );
});

function invocationLedger(): Record<string, string> {
  return {
    sourceGate: 'D3',
    ledgerSha256: 'c'.repeat(64),
    candidateId: 'd'.repeat(64),
    candidateManifestSha256: 'e'.repeat(64),
  };
}

function wireLedger(): Record<string, unknown> {
  return {
    ...invocationLedger(),
    artifactDigests: [{ artifactKey: 'runtime', sha256: 'f'.repeat(64) }],
  };
}
