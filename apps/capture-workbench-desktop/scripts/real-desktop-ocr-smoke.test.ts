// eslint-disable-next-line @nx/enforce-module-boundaries -- shared test temp-root guard.
import '../../../tools/test-temp-root.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- repository tooling reads shared release intent.
import { RELEASE_VERSION } from '../../../tools/release/release-intent.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser, Page } from '@playwright/test';

import {
  acceptanceScreenshot,
  assertDiagnosticsMatchesDurableOcr,
  assertPdfPageOneSemanticEvidence,
  assertExpectedOcrDevice,
  assertOcrExecutionProofMatchesInstalledJourney,
  assertRealDesktopSmokeEvidence,
  closeOwnedDesktopRoot,
  connectToPackagedPage,
  deleteCompletedDocument,
  DesktopOcrTerminalFailure,
  DesktopOcrLifecycleFailure,
  emitAcceptanceSemanticEvidence,
  establishOwnedDesktopLaunch,
  extractDurableOcrSegments,
  finalizeDesktopTeardown,
  isRealOcrWorkerFailure,
  isOwnedSmokeDocumentName,
  parseOcrProvenance,
  pinViewportToWindow,
  readAndAssertVisibleOcrPages,
  readDurableOcrProvenance,
  readOcrComputeModeFromSettings,
  readOcrProvenance,
  readWindowsMlOcrRequirementStatus,
  requestDesktopTeardown,
  realDesktopRuntimeReadyTimeoutMs,
  realDesktopTeardownTimeoutMs,
  resolveDesktopRuntimePreflight,
  resolveLocalInstalledRuntimeIdentity,
  resolveDesktopTeardownMode,
  resolveExpectedOcrDevice,
  runOcrFirstRunSetup,
  runtimeSetupDiagnostics,
  scrubLocalModelEnvironment,
  safeTerminalDesktopOcrFailure,
  verifyInstalledOcrExecutionProof,
  visibleRuntimeError,
  waitForDesktopOcrCompletion,
} from './real-desktop-ocr-smoke.ts';
import type { OcrSemanticEvidenceV1 } from './ocr-semantic-evidence.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test crosses the workspace journal seam.
import { openAcceptanceCheckpointWriter } from '../../../tools/acceptance-checkpoint-journal.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test crosses the workspace acceptance contract seam.
import {
  readOcrExecutionProof,
} from '../../../tools/acceptance-contract.ts';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(canonicalJson(item))));
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, JSON.parse(canonicalJson((value as Record<string, unknown>)[key]))]),
    ));
  }
  return JSON.stringify(value);
}

function executionProofFixture(): Record<string, unknown> {
  const identity = {
    adapterClass: 'dedicated',
    adapterLuid: '00000000000000aa',
    vendorId: '10de',
    deviceId: '2204',
    subsystemId: '00000001',
    revision: '01',
    description: 'test GPU',
  };
  const identitySha256 = sha256(canonicalJson(identity));
  const withoutDigest = {
    schemaVersion: '1',
    selectionProof: {
      identity: { ...identity, identitySha256 },
      highPerformanceRank: 0,
      dmlDeviceId: 0,
      adapterMapSha256: 'b'.repeat(64),
      planSha256: 'c'.repeat(64),
    },
    pipelineConstruction: {
      pre: {
        adapterLuid: '00000000000000aa',
        adapterMapSha256: 'b'.repeat(64),
        factoryCurrent: true,
      },
      post: {
        adapterLuid: '00000000000000aa',
        adapterMapSha256: 'b'.repeat(64),
        factoryCurrent: true,
      },
    },
    sessionDeviceProofs: [{
      sessionIndex: 0,
      providerOrder: ['DmlExecutionProvider', 'CPUExecutionProvider'],
      dmlDeviceId: 0,
      fallbackDisabled: true,
      dmlNodeCount: 2,
      cpuNodeCount: 1,
      evidenceSource: 'ort-graph-assignment',
    }],
    sourceSha256: 'd'.repeat(64),
    requestedPageScope: [1],
    dmlNodeCount: 2,
    runtimeSha256: 'e'.repeat(64),
    workerSha256: 'f'.repeat(64),
    modelSha256: '1'.repeat(64),
    profileId: 'capture-workbench-ocr-pipeline-v1',
    profileSpecSha256: '2'.repeat(64),
    contractSetSha256: '3'.repeat(64),
  };
  return {
    ...withoutDigest,
    executionSha256: sha256(canonicalJson(withoutDigest)),
  };
}

function phase1PageOnePdfSemanticFixture(): OcrSemanticEvidenceV1 {
  return {
    schemaVersion: 1,
    artifactPath: 'ocr-semantic-evidence-v1.json',
    runId: 'phase1-page-one-pdf',
    fixtureName: 'source.pdf',
    sourceKind: 'pdf',
    sourceSha256: '4'.repeat(64),
    captureId: 'capture-1',
    status: 'completed',
    ocrDevice: 'windowsml-dml',
    pageCount: 1,
    pages: [{
      page: 1,
      status: 'recognized',
      normalizedCharCount: 12,
      boxCount: 3,
      confidence: 0.875,
      confidenceSummary: {
        scoreState: 'numeric',
        numericCount: 3,
        min: 0.75,
        max: 1,
        mean: 0.875,
      },
    }],
    provenance: {
      runtimeVersion: RELEASE_VERSION,
      contractSha256: '5'.repeat(64),
      engine: 'windowsml-ocr',
      model: 'pp-ocrv6-medium-windowsml',
      modelDigest: `sha256:${'6'.repeat(64)}`,
      device: 'windowsml-dml',
      profileId: 'capture-workbench-ocr-pipeline-v1',
      profileSpecSha256: '7'.repeat(64),
      workerSha256: '8'.repeat(64),
    },
    rawNonEmpty: true,
    rawSegmentCount: 1,
    rawNonEmptySegmentCount: 1,
    resultNonEmpty: false,
    resultBlockCount: 0,
    resultNonEmptyBlockCount: 0,
    criticalAnchors: { expectedCount: 1, matchedCount: 1 },
    evidenceDigest: '9'.repeat(64),
  };
}

function isAlive(pid: number | undefined): boolean { try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; } }
async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (!isAlive(child.pid)) return;
  child.kill();
  await new Promise<void>((resolveClose) => child.once('close', resolveClose));
}

test('non-local desktop child environments remove all local model overrides', () => {
  const scrubbed = scrubLocalModelEnvironment({
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: '1',
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: 'C:\\private-model-root',
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256: 'a'.repeat(64),
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY: 'private-identity',
    SAFE_TEST_ENVIRONMENT: 'preserved',
  });
  assert.equal(scrubbed.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN, undefined);
  assert.equal(scrubbed.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT, undefined);
  assert.equal(scrubbed.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256, undefined);
  assert.equal(scrubbed.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY, undefined);
  assert.equal(scrubbed.SAFE_TEST_ENVIRONMENT, 'preserved');
});

test('owned launch failure paths close only the real owned child and preserve the primary error', async () => {
  for (const failure of ['spawn', 'scope', 'journal'] as const) {
    const root = await mkdtemp(join(tmpdir(), `capture-launch-${failure}-`));
    const baseline = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      let owned: ReturnType<typeof spawn> | undefined;
      const journal = await openAcceptanceCheckpointWriter({ eventRoot: root, project: 'capture-workbench', runId: 'run-1' });
      const checkpointJournal = failure === 'journal' ? { ...journal, complete: async () => { throw new Error('journal complete failure'); } } : journal;
      const scopeOwner = failure === 'scope' ? { recordLaunch: async () => { throw new Error('scope record failure'); } } : undefined;
      let closeAttempts = 0;
      const closeOwnedRoot = failure === 'scope'
        ? async (child: ReturnType<typeof spawn>) => { closeAttempts += 1; assert.equal(child, owned); return false; }
        : undefined;
      await assert.rejects(() => establishOwnedDesktopLaunch({ checkpointJournal, scopeOwner, ...(closeOwnedRoot ? { closeOwnedRoot } : {}), spawnChild: () => {
        const child = failure === 'spawn' ? spawn(join(root, 'missing.exe'), [], { stdio: 'ignore', windowsHide: true }) : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        owned = child;
        return child;
      } }), failure === 'journal' ? /journal complete failure/u : failure === 'scope' ? /scope record failure/u : undefined);
      if (failure === 'scope') {
        assert.ok(owned);
        assert.equal(closeAttempts, 1);
        assert.equal(isAlive(owned?.pid), true);
        const cleanupMessages: string[] = [];
        await finalizeDesktopTeardown(undefined, owned, 'window-close', (message) => cleanupMessages.push(message));
        assert.deepEqual(cleanupMessages, []);
        assert.equal(isAlive(owned?.pid), false);
      } else {
        assert.equal(isAlive(owned?.pid), false);
      }
      assert.equal(isAlive(baseline.pid), true);
    } finally {
      await stopProcess(baseline);
      await rm(root, { recursive: true, force: true });
    }
  }
});
test('production launch retains the exact child before ownership awaits', async () => {
  const events: string[] = [];
  let retained: ReturnType<typeof spawn> | undefined;
  const fakeChild = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => true,
  }) as unknown as ReturnType<typeof spawn>;

  await assert.rejects(
    () => establishOwnedDesktopLaunch({
      spawnChild: () => {
        events.push('spawnChild');
        queueMicrotask(() => (fakeChild as unknown as EventEmitter).emit('spawn'));
        return fakeChild;
      },
      onChildSpawned: (child) => {
        events.push('onChildSpawned');
        retained = child;
      },
      scopeOwner: {
        recordLaunch: async (pid) => {
          events.push(`recordLaunch:${pid}`);
          throw new Error('scope failure');
        },
      },
      closeOwnedRoot: async (child) => {
        events.push(`closeOwnedRoot:${child === retained}`);
        return false;
      },
    }),
    /scope failure/u,
  );

  assert.equal(retained, fakeChild);
  assert.deepEqual(events, [
    'spawnChild',
    'onChildSpawned',
    'recordLaunch:4242',
    'closeOwnedRoot:true',
  ]);
});
test('exact-root close is bounded when the child close adapter does not acknowledge', async () => {
  const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const kill = owned.kill.bind(owned);
  try {
    Object.defineProperty(owned, 'kill', { configurable: true, value: () => false });
    const started = Date.now();
    assert.equal(await closeOwnedDesktopRoot(owned, 25), false);
    assert.ok(Date.now() - started < 1_000, 'hung close must fail within its bound');
    Object.defineProperty(owned, 'kill', { configurable: true, value: kill });
    assert.equal(await closeOwnedDesktopRoot(owned, 1_000), true);
    assert.equal(isAlive(owned.pid), false);
  } finally {
    Object.defineProperty(owned, 'kill', { configurable: true, value: kill });
    await stopProcess(owned);
  }
});
test('production teardown closes the exact root when CDP is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-teardown-')); const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, stdio: 'ignore', windowsHide: true }); const baseline = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const started = Date.now();
    await finalizeDesktopTeardown(undefined, owned, 'window-close', () => undefined);
    assert.equal(isAlive(owned.pid), false); assert.equal(isAlive(baseline.pid), true); assert.ok(Date.now() - started < realDesktopTeardownTimeoutMs);
  } finally { await stopProcess(owned); await stopProcess(baseline); await rm(root, { recursive: true, force: true }); }
});

async function writeRuntimeCandidate(root: string, runtimeBytes: Buffer, newline = '\n'): Promise<{
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly runtimeManifestSha256: string;
  readonly runtimeSha256: string;
}> {
  const runtime = join(root, 'runtime');
  const contracts = join(root, 'contracts');
  await mkdir(runtime, { recursive: true });
  await mkdir(contracts, { recursive: true });
  const runtimeSha256 = sha256(runtimeBytes);
  const schemaBytes = Buffer.from('{"schemaVersion":"2"}\n');
  const schemaSha256 = sha256(schemaBytes);
  const runtimeManifest = {
    apiVersion: '2.0',
    arch: 'x86_64',
    bytes: runtimeBytes.length,
    captureDocumentSchemaVersion: '2',
    fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
    manifestVersion: '1',
    platform: 'windows',
    runtimeVersion: RELEASE_VERSION,
    schemaFileName: 'capture-document-v2.schema.json',
    schemaSha256,
    sha256: runtimeSha256,
  };
  const runtimeManifestBytes = Buffer.from(`${JSON.stringify(runtimeManifest)}${newline}`);
  const runtimeManifestSha256 = sha256(runtimeManifestBytes);
  await writeFile(join(runtime, runtimeManifest.fileName), runtimeBytes);
  await writeFile(join(runtime, 'capture-runtime-manifest.json'), runtimeManifestBytes);
  await writeFile(join(runtime, 'capture-document-v2.schema.json'), schemaBytes);
  const contractSetBytes = Buffer.from('contract-set\n');
  const contractSetSha256 = sha256(contractSetBytes);
  await writeFile(join(contracts, 'contract-set.json'), contractSetBytes);
  await writeFile(join(contracts, 'contract-set.sha256'), `${contractSetSha256}\n`);
  const baseManifest = {
    schemaVersion: '1',
    candidateKind: 'runtime',
    sourceCommit: 'a'.repeat(40),
    releaseVersion: RELEASE_VERSION,
    releaseMode: 'model-enabled',
    producerRunId: 'run-1',
    packageCandidateId: 'b'.repeat(64),
    contractSetSha256,
    artifacts: [
      { bytes: runtimeBytes.length, path: `runtime/${runtimeManifest.fileName}`, sha256: runtimeSha256 },
      { bytes: runtimeManifestBytes.length, path: 'runtime/capture-runtime-manifest.json', sha256: runtimeManifestSha256 },
    ],
    toolchains: { node: 'v24.0.0', python: '3.12', runtime: 'capture-runtime' },
  };
  const candidateId = sha256(JSON.stringify(baseManifest));
  const candidateManifestBytes = Buffer.from(`${JSON.stringify({ ...baseManifest, candidateId })}\n`);
  await writeFile(join(root, 'candidate-manifest.json'), candidateManifestBytes);
  return {
    candidateId,
    candidateManifestSha256: sha256(candidateManifestBytes),
    runtimeManifestSha256,
    runtimeSha256,
  };
}

test('local package identity uses the actual installed runtime when source-staged bytes differ', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  await mkdir(installRoot, { recursive: true });
  const installedBytes = Buffer.from('installed-runtime-bytes');
  const candidate = await writeRuntimeCandidate(candidateRoot, installedBytes);
  const installedRuntime = join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe');
  await mkdir(join(installRoot, 'binaries'), { recursive: true });
  await mkdir(join(installRoot, 'resources'), { recursive: true });
  await writeFile(installedRuntime, installedBytes);
  await writeFile(
    join(installRoot, 'resources', 'capture-runtime-manifest.json'),
    JSON.stringify({
      apiVersion: '2.0',
      arch: 'x86_64',
      bytes: installedBytes.length,
      captureDocumentSchemaVersion: '2',
      fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
      manifestVersion: '1',
      platform: 'windows',
      runtimeVersion: RELEASE_VERSION,
      schemaFileName: 'capture-document-v2.schema.json',
      schemaSha256: sha256('{"schemaVersion":"2"}\n'),
      sha256: sha256(installedBytes),
    }) + '\n',
  );
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  const identity = await resolveLocalInstalledRuntimeIdentity({
    installedExecutablePath: installedExecutable,
    candidateRoot,
    candidateId: candidate.candidateId,
    installerProvenance: {
      buildFlavor: 'acceptance',
      stagedRuntimeSha256: candidate.runtimeSha256,
      runtimeManifestSha256: candidate.runtimeManifestSha256,
    },
    sourceStagedRuntimeSha256: sha256('different-source-staged-runtime'),
  });

  assert.equal(identity.sourceRole, 'actual-installed-runtime');
  assert.equal(identity.runtimeSha256, candidate.runtimeSha256);
  assert.equal(identity.runtimeSha256 !== identity.sourceStagedRuntimeSha256, true);
  assert.equal(identity.candidateId, candidate.candidateId);
  assert.equal(identity.runtimeVersion, RELEASE_VERSION);
  assert.equal(identity.contractSetSha256.length, 64);
});

test('local package identity accepts an installed candidate under an ancestor junction alias', async () => {
  const physicalRoot = await mkdtemp(join(tmpdir(), 'capture-local-identity-ancestor-physical-'));
  const aliasRoot = join(
    tmpdir(),
    `capture-local-identity-ancestor-alias-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    await symlink(physicalRoot, aliasRoot, 'junction');
    assert.notEqual(await realpath(aliasRoot), aliasRoot);
    const root = join(aliasRoot, 'run');
    const candidateRoot = join(root, 'candidate');
    const installRoot = join(root, 'install');
    await mkdir(join(installRoot, 'binaries'), { recursive: true });
    await mkdir(join(installRoot, 'resources'), { recursive: true });
    const runtimeBytes = Buffer.from('ancestor-runtime');
    const candidate = await writeRuntimeCandidate(candidateRoot, runtimeBytes);
    await writeFile(
      join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'),
      runtimeBytes,
    );
    await writeFile(
      join(installRoot, 'resources', 'capture-runtime-manifest.json'),
      JSON.stringify({
        apiVersion: '2.0',
        arch: 'x86_64',
        bytes: runtimeBytes.length,
        captureDocumentSchemaVersion: '2',
        fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
        manifestVersion: '1',
        platform: 'windows',
        runtimeVersion: RELEASE_VERSION,
        schemaFileName: 'capture-document-v2.schema.json',
        schemaSha256: sha256('{"schemaVersion":"2"}\n'),
        sha256: sha256(runtimeBytes),
      }) + '\n',
    );
    const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
    await writeFile(installedExecutable, 'desktop');

    const identity = await resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: installedExecutable,
      candidateRoot,
      candidateId: candidate.candidateId,
      installerProvenance: {
        buildFlavor: 'acceptance',
        stagedRuntimeSha256: candidate.runtimeSha256,
        runtimeManifestSha256: candidate.runtimeManifestSha256,
      },
    });

    assert.equal(identity.runtimeSha256, candidate.runtimeSha256);
    assert.equal(identity.candidateId, candidate.candidateId);
  } finally {
    await rm(aliasRoot, { force: true });
    await rm(physicalRoot, { recursive: true, force: true });
  }
});

test('local package identity accepts installed manifest serialization differences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-manifest-serialization-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  await mkdir(join(installRoot, 'binaries'), { recursive: true });
  await mkdir(join(installRoot, 'resources'), { recursive: true });
  const runtimeBytes = Buffer.from('candidate-runtime');
  const candidate = await writeRuntimeCandidate(candidateRoot, runtimeBytes, '\r\n');
  await writeFile(join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'), runtimeBytes);
  const candidateRuntimeManifestBytes = await readFile(join(candidateRoot, 'runtime', 'capture-runtime-manifest.json'));
  const installedRuntimeManifestBytes = Buffer.from(candidateRuntimeManifestBytes.toString('utf8').replaceAll('\r\n', '\n'));
  assert.notEqual(sha256(candidateRuntimeManifestBytes), sha256(installedRuntimeManifestBytes));
  await writeFile(join(installRoot, 'resources', 'capture-runtime-manifest.json'), installedRuntimeManifestBytes);
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  const identity = await resolveLocalInstalledRuntimeIdentity({
    installedExecutablePath: installedExecutable,
    candidateRoot,
    candidateId: candidate.candidateId,
    installerProvenance: {
      buildFlavor: 'acceptance',
      stagedRuntimeSha256: candidate.runtimeSha256,
      runtimeManifestSha256: sha256(installedRuntimeManifestBytes),
    },
    sourceStagedRuntimeSha256: sha256('different-source-staged-runtime'),
  });

  assert.equal(identity.runtimeSha256, candidate.runtimeSha256);
  assert.equal(identity.runtimeManifestSha256, sha256(installedRuntimeManifestBytes));

  await assert.rejects(
    resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: installedExecutable,
      candidateRoot,
      candidateId: candidate.candidateId,
      installerProvenance: {
        buildFlavor: 'acceptance',
        stagedRuntimeSha256: candidate.runtimeSha256,
        runtimeManifestSha256: candidate.runtimeManifestSha256,
      },
    }),
    /installer provenance/u,
  );
});

test('local package identity fails closed for a semantic installed manifest drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-manifest-drift-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  await mkdir(join(installRoot, 'binaries'), { recursive: true });
  await mkdir(join(installRoot, 'resources'), { recursive: true });
  const runtimeBytes = Buffer.from('candidate-runtime');
  const candidate = await writeRuntimeCandidate(candidateRoot, runtimeBytes);
  await writeFile(join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'), runtimeBytes);
  const candidateRuntimeManifest = JSON.parse(
    await readFile(join(candidateRoot, 'runtime', 'capture-runtime-manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  candidateRuntimeManifest.apiVersion = '1.0';
  const installedRuntimeManifestBytes = Buffer.from(`${JSON.stringify(candidateRuntimeManifest)}\n`);
  await writeFile(join(installRoot, 'resources', 'capture-runtime-manifest.json'), installedRuntimeManifestBytes);
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  await assert.rejects(
    resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: installedExecutable,
      candidateRoot,
      candidateId: candidate.candidateId,
      installerProvenance: {
        buildFlavor: 'acceptance',
        stagedRuntimeSha256: candidate.runtimeSha256,
        runtimeManifestSha256: sha256(installedRuntimeManifestBytes),
      },
    }),
    /semantic identity/u,
  );
});

test('local package identity rejects unsupported installed manifest fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-manifest-fields-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  await mkdir(join(installRoot, 'binaries'), { recursive: true });
  await mkdir(join(installRoot, 'resources'), { recursive: true });
  const runtimeBytes = Buffer.from('candidate-runtime');
  const candidate = await writeRuntimeCandidate(candidateRoot, runtimeBytes);
  await writeFile(join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'), runtimeBytes);
  const installedRuntimeManifest = JSON.parse(
    await readFile(join(candidateRoot, 'runtime', 'capture-runtime-manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  installedRuntimeManifest.unownedDiagnostic = 'must-not-be-ignored';
  const installedRuntimeManifestBytes = Buffer.from(`${JSON.stringify(installedRuntimeManifest)}\n`);
  await writeFile(join(installRoot, 'resources', 'capture-runtime-manifest.json'), installedRuntimeManifestBytes);
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  await assert.rejects(
    resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: installedExecutable,
      candidateRoot,
      candidateId: candidate.candidateId,
      installerProvenance: {
        buildFlavor: 'acceptance',
        stagedRuntimeSha256: candidate.runtimeSha256,
        runtimeManifestSha256: sha256(installedRuntimeManifestBytes),
      },
    }),
    /unsupported or missing/u,
  );
});

test('local package identity keeps candidate manifest artifact bytes strict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-candidate-manifest-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  await mkdir(installRoot, { recursive: true });
  const candidate = await writeRuntimeCandidate(candidateRoot, Buffer.from('candidate-runtime'));
  const candidateRuntimeManifestPath = join(candidateRoot, 'runtime', 'capture-runtime-manifest.json');
  const candidateRuntimeManifestBytes = await readFile(candidateRuntimeManifestPath);
  await writeFile(candidateRuntimeManifestPath, Buffer.concat([candidateRuntimeManifestBytes, Buffer.from('\n')]));
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  await assert.rejects(
    resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: installedExecutable,
      candidateRoot,
      candidateId: candidate.candidateId,
      installerProvenance: {
        buildFlavor: 'acceptance',
        stagedRuntimeSha256: candidate.runtimeSha256,
        runtimeManifestSha256: candidate.runtimeManifestSha256,
      },
    }),
    /Runtime candidate manifest artifact is not self-consistent/u,
  );
});

test('local package identity fails closed for an installed runtime not allowed by candidate provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-tampered-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  await mkdir(installRoot, { recursive: true });
  const candidate = await writeRuntimeCandidate(candidateRoot, Buffer.from('candidate-runtime'));
  const installedBytes = Buffer.from('tampered-installed-runtime');
  await mkdir(join(installRoot, 'binaries'), { recursive: true });
  await mkdir(join(installRoot, 'resources'), { recursive: true });
  await writeFile(join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'), installedBytes);
  await writeFile(
    join(installRoot, 'resources', 'capture-runtime-manifest.json'),
    JSON.stringify({
      apiVersion: '2.0', arch: 'x86_64', bytes: installedBytes.length,
      captureDocumentSchemaVersion: '2', fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
      manifestVersion: '1', platform: 'windows', runtimeVersion: RELEASE_VERSION,
      schemaFileName: 'capture-document-v2.schema.json', schemaSha256: sha256('{"schemaVersion":"2"}\n'),
      sha256: sha256(installedBytes),
    }) + '\n',
  );
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  await assert.rejects(
    resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: installedExecutable,
      candidateRoot,
      candidateId: candidate.candidateId,
      installerProvenance: {
        buildFlavor: 'acceptance',
        stagedRuntimeSha256: candidate.runtimeSha256,
        runtimeManifestSha256: candidate.runtimeManifestSha256,
      },
      sourceStagedRuntimeSha256: sha256('different-source-staged-runtime'),
    }),
    /installed runtime is not allowed by the candidate/u,
  );
});

test('local package identity fails closed when installer provenance is wrong', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-provenance-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  await mkdir(join(installRoot, 'binaries'), { recursive: true });
  await mkdir(join(installRoot, 'resources'), { recursive: true });
  const runtimeBytes = Buffer.from('candidate-runtime');
  const candidate = await writeRuntimeCandidate(candidateRoot, runtimeBytes);
  await writeFile(join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'), runtimeBytes);
  await writeFile(
    join(installRoot, 'resources', 'capture-runtime-manifest.json'),
    JSON.stringify({
      apiVersion: '2.0', arch: 'x86_64', bytes: runtimeBytes.length,
      captureDocumentSchemaVersion: '2', fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
      manifestVersion: '1', platform: 'windows', runtimeVersion: RELEASE_VERSION,
      schemaFileName: 'capture-document-v2.schema.json', schemaSha256: sha256('{"schemaVersion":"2"}\n'),
      sha256: sha256(runtimeBytes),
    }) + '\n',
  );
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  await assert.rejects(
    resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: installedExecutable,
      candidateRoot,
      candidateId: candidate.candidateId,
      installerProvenance: {
        buildFlavor: 'acceptance',
        stagedRuntimeSha256: 'c'.repeat(64),
        runtimeManifestSha256: candidate.runtimeManifestSha256,
      },
      sourceStagedRuntimeSha256: sha256('different-source-staged-runtime'),
    }),
    /installer provenance/u,
  );
});

test('local package identity fails closed when the installed root has split runtime resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-split-root-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  await mkdir(join(installRoot, 'binaries'), { recursive: true });
  await mkdir(join(installRoot, 'resources'), { recursive: true });
  const runtimeBytes = Buffer.from('candidate-runtime');
  const candidate = await writeRuntimeCandidate(candidateRoot, runtimeBytes);
  const runtimeManifest = JSON.stringify({
    apiVersion: '2.0', arch: 'x86_64', bytes: runtimeBytes.length,
    captureDocumentSchemaVersion: '2', fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
    manifestVersion: '1', platform: 'windows', runtimeVersion: RELEASE_VERSION,
    schemaFileName: 'capture-document-v2.schema.json', schemaSha256: sha256('{"schemaVersion":"2"}\n'),
    sha256: sha256(runtimeBytes),
  }) + '\n';
  await writeFile(join(installRoot, 'capture-runtime-manifest.json'), runtimeManifest);
  await writeFile(join(installRoot, 'resources', 'capture-runtime-manifest.json'), runtimeManifest);
  await writeFile(join(installRoot, 'capture-runtime-x86_64-pc-windows-msvc.exe'), runtimeBytes);
  await writeFile(join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'), runtimeBytes);
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  const resolveIdentity = () => resolveLocalInstalledRuntimeIdentity({
    installedExecutablePath: installedExecutable,
    candidateRoot,
    candidateId: candidate.candidateId,
    installerProvenance: {
      buildFlavor: 'acceptance',
      stagedRuntimeSha256: candidate.runtimeSha256,
      runtimeManifestSha256: candidate.runtimeManifestSha256,
    },
    sourceStagedRuntimeSha256: sha256('different-source-staged-runtime'),
  });

  await assert.rejects(
    resolveIdentity(),
    /installed runtime manifest must resolve to exactly one canonical file/u,
  );
  await rm(join(installRoot, 'capture-runtime-manifest.json'));
  await writeFile(join(installRoot, 'resources', 'capture-runtime-x86_64-pc-windows-msvc.exe'), runtimeBytes);
  await assert.rejects(
    resolveIdentity(),
    /installed runtime executable must resolve to exactly one canonical file/u,
  );
});

test('local package identity fails closed when an installed canonical resource escapes through a junction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-identity-junction-'));
  const candidateRoot = join(root, 'candidate');
  const installRoot = join(root, 'install');
  const escapedResources = join(root, 'escaped-resources');
  const runtimeBytes = Buffer.from('candidate-runtime');
  const candidate = await writeRuntimeCandidate(candidateRoot, runtimeBytes);
  await mkdir(join(installRoot, 'binaries'), { recursive: true });
  await mkdir(escapedResources, { recursive: true });
  await writeFile(join(escapedResources, 'capture-runtime-manifest.json'), '{"escaped":true}\n');
  try {
    await symlink(escapedResources, join(installRoot, 'resources'), 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EPERM') {
      t.skip('junction creation is unavailable in this environment');
      return;
    }
    throw error;
  }
  await writeFile(join(installRoot, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'), runtimeBytes);
  const installedExecutable = join(installRoot, 'capture-workbench-desktop.exe');
  await writeFile(installedExecutable, 'desktop');

  await assert.rejects(
    resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: installedExecutable,
      candidateRoot,
      candidateId: candidate.candidateId,
      installerProvenance: {
        buildFlavor: 'acceptance',
        stagedRuntimeSha256: candidate.runtimeSha256,
        runtimeManifestSha256: candidate.runtimeManifestSha256,
      },
    }),
    /installed runtime manifest must not resolve through a link/u,
  );
});

const fakeInstalledRuntimeIdentity = {
  policy: 'local-package-tiered' as const,
  sourceRole: 'actual-installed-runtime' as const,
  installRoot: 'C:/owned/install',
  runtimePath: 'C:/owned/install/binaries/runtime.exe',
  runtimeSha256: '1'.repeat(64),
  runtimeVersion: RELEASE_VERSION,
  runtimeManifestSha256: '2'.repeat(64),
  contractSetSha256: '3'.repeat(64),
  candidateId: '4'.repeat(64),
};

test('local preflight ignores missing source-stage diagnostics and uses the installed candidate identity', async () => {
  let installedSourceDiagnostic: string | undefined = 'unexpected';
  const result = await resolveDesktopRuntimePreflight({
    acceptance: true,
    readStrictStagedRuntime: async () => {
      throw new Error('strict source-stage read must not gate local acceptance');
    },
    readOptionalStagedRuntime: async () => {
      throw new Error('source-stage is absent');
    },
    resolveInstalledRuntime: async (sourceStagedRuntimeSha256) => {
      installedSourceDiagnostic = sourceStagedRuntimeSha256;
      return fakeInstalledRuntimeIdentity;
    },
  });

  assert.equal(installedSourceDiagnostic, undefined);
  assert.equal(result.expectedRuntimeSha256, fakeInstalledRuntimeIdentity.runtimeSha256);
  assert.equal(result.sourceStagedRuntimeSha256, undefined);
  assert.equal(result.localInstalledRuntime, fakeInstalledRuntimeIdentity);
});

test('local preflight ignores old or corrupt source-stage diagnostics without fabricating a digest', async () => {
  for (const optionalStage of [
    async () => { throw new Error('source-stage is old'); },
    async () => ({ digest: 'not-a-sha256' }),
  ]) {
    let installedSourceDiagnostic: string | undefined = 'unexpected';
    const result = await resolveDesktopRuntimePreflight({
      acceptance: true,
      readStrictStagedRuntime: async () => {
        throw new Error('strict source-stage read must not gate local acceptance');
      },
      readOptionalStagedRuntime: optionalStage,
      resolveInstalledRuntime: async (sourceStagedRuntimeSha256) => {
        installedSourceDiagnostic = sourceStagedRuntimeSha256;
        return fakeInstalledRuntimeIdentity;
      },
    });

    assert.equal(installedSourceDiagnostic, undefined);
    assert.equal(result.expectedRuntimeSha256, fakeInstalledRuntimeIdentity.runtimeSha256);
    assert.equal(result.sourceStagedRuntimeSha256, undefined);
  }
});

test('non-local preflight keeps strict source-stage identity and fails when it is missing', async () => {
  let optionalRead = false;
  let installedRead = false;
  const strictDigest = 'a'.repeat(64);
  const result = await resolveDesktopRuntimePreflight({
    acceptance: false,
    readStrictStagedRuntime: async () => ({ digest: strictDigest }),
    readOptionalStagedRuntime: async () => {
      optionalRead = true;
      return { digest: 'o'.repeat(64) };
    },
    resolveInstalledRuntime: async () => {
      installedRead = true;
      return fakeInstalledRuntimeIdentity;
    },
  });

  assert.equal(result.expectedRuntimeSha256, strictDigest);
  assert.equal(result.sourceStagedRuntimeSha256, strictDigest);
  assert.equal(result.localInstalledRuntime, undefined);
  assert.equal(optionalRead, false);
  assert.equal(installedRead, false);
  await assert.rejects(
    resolveDesktopRuntimePreflight({
      acceptance: false,
      readStrictStagedRuntime: async () => {
        throw new Error('strict source-stage missing');
      },
      readOptionalStagedRuntime: async () => ({ digest: 'o'.repeat(64) }),
      resolveInstalledRuntime: async () => fakeInstalledRuntimeIdentity,
    }),
    /strict source-stage missing/u,
  );
});

test('non-acceptance desktop OCR evidence requires OCR-only checkpoint invariants, cleanup, and redaction', () => {
  assert.equal(realDesktopRuntimeReadyTimeoutMs, 180_000);
  const valid = {
    evidenceKind: 'real-standalone-tauri-ui-ocr',
    acceptanceMode: 'ocr-only',
    releaseGateSatisfied: false,
    realEnginesExercised: true,
    sourceKind: 'pdf',
    rawOcrVisible: true,
    ocrResultVerified: true,
    ocrProjectionVerified: true,
    rawOcrSegmentCount: 2,
    structuredBlockCount: 0,
    expectedAnchorCount: 4,
    matchedAnchorCount: 4,
    ocrDevice: 'windowsml-dml',
    documentDeletedAfterVerification: true,
  };

  assert.doesNotThrow(() => assertRealDesktopSmokeEvidence(valid, { acceptance: false }));
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, releaseGateSatisfied: true }, { acceptance: false }),
    /Expected values to be strictly equal/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, structuringEngine: 'ollama' }, { acceptance: false }),
    /Expected values to be strictly equal/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, ocrExecutionProof: executionProofFixture() }, { acceptance: false }),
    /Expected values to be strictly equal/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, documentDeletedAfterVerification: false }, { acceptance: false }),
    /Expected values to be strictly equal/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, ocrDevice: 'unknown' }, { acceptance: false }),
    /falsy value|false/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, note: 'C:\\outside\\source.pdf' }, { acceptance: false }),
    /expected to not match/u,
  );
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, authorization: 'Bearer unsafe' }, { acceptance: false }),
    /authorization material/u,
  );
});

test('Phase 1 OCR-only acceptance keeps OCR semantic, projection, GPU, and cleanup gates without structuring', async () => {
  const proofRoot = await mkdtemp(join(tmpdir(), 'capture-ocr-only-proof-'));
  const proofBytes = Buffer.from(`${canonicalJson(executionProofFixture())}\n`);
  await writeFile(join(proofRoot, 'ocr-device-proof-v1.json'), proofBytes);
  const proof = await readOcrExecutionProof(proofRoot);
  const valid = {
    evidenceKind: 'real-standalone-tauri-ui-ocr',
    acceptanceMode: 'ocr-only',
    releaseGateSatisfied: false,
    realEnginesExercised: true,
    sourceKind: 'pdf',
    rawOcrVisible: true,
    ocrResultVerified: true,
    ocrProjectionVerified: true,
    rawOcrSegmentCount: 2,
    structuredBlockCount: 0,
    expectedAnchorCount: 4,
    matchedAnchorCount: 4,
    ocrDevice: 'windowsml-dml',
    documentDeletedAfterVerification: true,
    ocrExecutionProof: proof,
  };

  try {
    assert.equal(proof.artifactPath, 'ocr-device-proof-v1.json');
    assert.equal(proof.schemaVersion, '1');
    assert.equal(proof.dmlNodeCount, 2);
    assert.equal(proof.sessionCount, 1);
    assert.equal(proof.sourceSha256, 'd'.repeat(64));
    assert.equal(proof.runtimeSha256, 'e'.repeat(64));
    assert.equal(proof.workerSha256, 'f'.repeat(64));
    assert.equal(proof.contractSetSha256, '3'.repeat(64));
    assert.deepEqual(proof.requestedPageScope, [1]);
    assertOcrExecutionProofMatchesInstalledJourney(proof, {
      sourceSha256: 'd'.repeat(64),
      runtimeSha256: 'e'.repeat(64),
      workerSha256: 'f'.repeat(64),
      contractSha256: '3'.repeat(64),
      sourceKind: 'pdf',
    });
    for (const item of [
      ['source', { sourceSha256: '0'.repeat(64) }, /source digest/u],
      ['runtime', { runtimeSha256: '0'.repeat(64) }, /runtime digest/u],
      ['worker', { workerSha256: '0'.repeat(64) }, /worker digest/u],
      ['contract', { contractSetSha256: '0'.repeat(64) }, /contract digest/u],
      ['page scope', { requestedPageScope: [2] }, /page scope/u],
      ['DML execution', { dmlNodeCount: 0 }, /did not prove DML/u],
    ] as const) {
      assert.throws(
        () => assertOcrExecutionProofMatchesInstalledJourney({ ...proof, ...item[1] }, {
          sourceSha256: 'd'.repeat(64),
          runtimeSha256: 'e'.repeat(64),
          workerSha256: 'f'.repeat(64),
          contractSha256: '3'.repeat(64),
          sourceKind: 'pdf',
        }),
        item[2],
        item[0],
      );
    }
    const malformedDml = executionProofFixture();
    malformedDml.dmlNodeCount = 0;
    const malformedDmlRoot = await mkdtemp(join(tmpdir(), 'capture-ocr-only-proof-dml-'));
    try {
      await writeFile(
        join(malformedDmlRoot, 'ocr-device-proof-v1.json'),
        `${canonicalJson(malformedDml)}\n`,
      );
      await assert.rejects(
        () => readOcrExecutionProof(malformedDmlRoot),
        /aggregate DML node count is invalid|DML node count must be positive/u,
      );
    } finally {
      await rm(malformedDmlRoot, { recursive: true, force: true });
    }
    assert.doesNotThrow(() => assertRealDesktopSmokeEvidence(valid, { acceptance: true }));
    assert.throws(
      () => assertRealDesktopSmokeEvidence({ ...valid, releaseGateSatisfied: true }, { acceptance: true }),
      /Expected values to be strictly equal/u,
      'OCR proof must not be reported as structuring or release success',
    );
    assert.throws(
      () => assertRealDesktopSmokeEvidence({ ...valid, structuredBlockCount: 1 }, { acceptance: true }),
      /Expected values to be strictly equal/u,
      'OCR-only evidence must not fabricate structured blocks',
    );
    assert.throws(
      () => assertRealDesktopSmokeEvidence({ ...valid, ocrExecutionProof: undefined }, { acceptance: true }),
      /falsy value|false/u,
      'OCR-only evidence must retain its execution proof',
    );
  } finally {
    await rm(proofRoot, { recursive: true, force: true });
  }
});

test('Phase 1 PDF semantic gate keeps multi-page sources page-one scoped and accepts contract boundaries', () => {
  for (const sourcePageCount of [1, 46, 500]) {
    for (const confidence of [0, 1]) {
      const semanticEvidence = phase1PageOnePdfSemanticFixture();
      const page = semanticEvidence.pages[0];
      assert.ok(page);
      assert.doesNotThrow(() => assertPdfPageOneSemanticEvidence(
        {
          sourcePageCount,
          requestedPageNumbers: [1],
          processedPageNumbers: [1],
        },
        {
          ...semanticEvidence,
          pages: [{
            ...page,
            boxCount: 1,
            confidence,
            confidenceSummary: {
              ...page.confidenceSummary,
              numericCount: 1,
            },
          }],
        },
      ));
    }
  }
});

test('Phase 1 page-one PDF semantic gate rejects scope and semantic drift before artifact write', () => {
  const validScope = {
    sourcePageCount: 46,
    requestedPageNumbers: [1],
    processedPageNumbers: [1],
  } as const;
  const validSemantic = phase1PageOnePdfSemanticFixture();
  const validPage = validSemantic.pages[0];
  assert.ok(validPage);

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly scope?: Parameters<typeof assertPdfPageOneSemanticEvidence>[0];
    readonly semantic?: OcrSemanticEvidenceV1;
    readonly error: RegExp;
  }> = [
    { name: 'zero source page count', scope: { ...validScope, sourcePageCount: 0 }, error: /source page count/u },
    { name: 'fractional source page count', scope: { ...validScope, sourcePageCount: 1.5 }, error: /source page count/u },
    { name: 'excessive source page count', scope: { ...validScope, sourcePageCount: 501 }, error: /source page count/u },
    { name: 'empty requested page scope', scope: { ...validScope, requestedPageNumbers: [] }, error: /page-one scope/u },
    { name: 'wrong requested page scope', scope: { ...validScope, requestedPageNumbers: [2] }, error: /page-one scope/u },
    { name: 'extra requested page scope', scope: { ...validScope, requestedPageNumbers: [1, 2] }, error: /page-one scope/u },
    { name: 'empty processed page scope', scope: { ...validScope, processedPageNumbers: [] }, error: /page-one scope/u },
    { name: 'wrong processed page scope', scope: { ...validScope, processedPageNumbers: [2] }, error: /page-one scope/u },
    { name: 'extra processed page scope', scope: { ...validScope, processedPageNumbers: [1, 2] }, error: /page-one scope/u },
    { name: 'source kind', semantic: { ...validSemantic, sourceKind: 'image' }, error: /sourceKind/u },
    { name: 'semantic status', semantic: { ...validSemantic, status: 'failed' }, error: /semantic status/u },
    { name: 'zero semantic page count', semantic: { ...validSemantic, pageCount: 0 }, error: /pageCount/u },
    { name: 'semantic page count', semantic: { ...validSemantic, pageCount: 2 }, error: /pageCount/u },
    { name: 'empty semantic pages', semantic: { ...validSemantic, pages: [] }, error: /exactly one page/u },
    {
      name: 'semantic page cardinality',
      semantic: { ...validSemantic, pages: [validPage, { ...validPage, page: 2 }] },
      error: /exactly one page/u,
    },
    { name: 'semantic page number', semantic: { ...validSemantic, pages: [{ ...validPage, page: 2 }] }, error: /page number/u },
    { name: 'semantic page status', semantic: { ...validSemantic, pages: [{ ...validPage, status: 'empty' }] }, error: /recognized/u },
    { name: 'negative semantic box count', semantic: { ...validSemantic, pages: [{ ...validPage, boxCount: -1 }] }, error: /boxCount/u },
    { name: 'semantic box count', semantic: { ...validSemantic, pages: [{ ...validPage, boxCount: 0 }] }, error: /boxCount/u },
    { name: 'null page confidence', semantic: { ...validSemantic, pages: [{ ...validPage, confidence: null }] }, error: /confidence.*finite.*0.*1/iu },
    { name: 'NaN page confidence', semantic: { ...validSemantic, pages: [{ ...validPage, confidence: Number.NaN }] }, error: /confidence.*finite.*0.*1/iu },
    { name: 'negative infinite page confidence', semantic: { ...validSemantic, pages: [{ ...validPage, confidence: Number.NEGATIVE_INFINITY }] }, error: /confidence.*finite.*0.*1/iu },
    { name: 'positive infinite page confidence', semantic: { ...validSemantic, pages: [{ ...validPage, confidence: Number.POSITIVE_INFINITY }] }, error: /confidence.*finite.*0.*1/iu },
    { name: 'negative page confidence', semantic: { ...validSemantic, pages: [{ ...validPage, confidence: -0.0001 }] }, error: /confidence.*finite.*0.*1/iu },
    { name: 'high page confidence', semantic: { ...validSemantic, pages: [{ ...validPage, confidence: 1.0001 }] }, error: /confidence.*finite.*0.*1/iu },
    {
      name: 'semantic score state',
      semantic: {
        ...validSemantic,
        pages: [{ ...validPage, confidenceSummary: { ...validPage.confidenceSummary, scoreState: 'none' } }],
      },
      error: /scoreState/u,
    },
    {
      name: 'negative semantic numeric score count',
      semantic: {
        ...validSemantic,
        pages: [{ ...validPage, confidenceSummary: { ...validPage.confidenceSummary, numericCount: -1 } }],
      },
      error: /numericCount/u,
    },
    {
      name: 'semantic numeric score count',
      semantic: {
        ...validSemantic,
        pages: [{ ...validPage, confidenceSummary: { ...validPage.confidenceSummary, numericCount: 0 } }],
      },
      error: /numericCount/u,
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => assertPdfPageOneSemanticEvidence(
        item.scope ?? validScope,
        item.semantic ?? validSemantic,
      ),
      item.error,
      item.name,
    );
  }
});

test('Phase 1 PDF semantic owner gates PDFs before the atomic artifact writer', async () => {
  const validSemantic = phase1PageOnePdfSemanticFixture();
  const validScope = {
    sourcePageCount: 46,
    requestedPageNumbers: [1],
    processedPageNumbers: [1],
  } as const;
  const fakeIdentity = {
    path: validSemantic.artifactPath,
    bytes: 123,
    sha256: 'a'.repeat(64),
  };

  // 1. OCR-only PDF: builds OCR-only evidence, runs PDF page-one gate, then writes.
  const pdfCalls: string[] = [];
  await emitAcceptanceSemanticEvidence({
    sourceKind: 'pdf',
    artifactRoot: 'C:\\artifacts',
    pdfPageScope: validScope,
    buildOcrOnly: () => {
      pdfCalls.push('buildOcrOnly');
      return validSemantic;
    },
    assertPdfPageOne: (scope, evidence) => {
      pdfCalls.push('assertPdfPageOne');
      assertPdfPageOneSemanticEvidence(scope, evidence);
    },
    writeArtifact: async (path) => {
      pdfCalls.push(`writeArtifact:${path}`);
      return fakeIdentity;
    },
  });
  assert.deepEqual(pdfCalls, [
    'buildOcrOnly',
    'assertPdfPageOne',
    `writeArtifact:${join('C:\\artifacts', validSemantic.artifactPath)}`,
  ]);

  // 2. OCR-only PDF gate failure prevents writing the artifact.
  let wroteOnFailure = false;
  await assert.rejects(
    () => emitAcceptanceSemanticEvidence({
      sourceKind: 'pdf',
      artifactRoot: 'C:\\artifacts',
      pdfPageScope: { ...validScope, processedPageNumbers: [2] },
      buildOcrOnly: () => validSemantic,
      writeArtifact: async () => {
        wroteOnFailure = true;
        return fakeIdentity;
      },
    }),
    /page-one scope/u,
  );
  assert.equal(wroteOnFailure, false);

  // 3. OCR-only image: skips PDF gate and still writes the artifact.
  const imageCalls: string[] = [];
  await emitAcceptanceSemanticEvidence({
    sourceKind: 'image',
    artifactRoot: 'C:\\artifacts',
    buildOcrOnly: () => {
      imageCalls.push('buildOcrOnly');
      return { ...validSemantic, sourceKind: 'image' };
    },
    assertPdfPageOne: () => {
      imageCalls.push('assertPdfPageOne');
    },
    writeArtifact: async () => {
      imageCalls.push('writeArtifact');
      return fakeIdentity;
    },
  });
  assert.deepEqual(imageCalls, ['buildOcrOnly', 'writeArtifact']);
});

test('Phase 1 installed acceptance wires OCR proof validation before deferred structuring', async () => {
  const missingRoot = await mkdtemp(join(tmpdir(), 'capture-ocr-only-proof-missing-'));
  try {
    await assert.rejects(
      () => readOcrExecutionProof(missingRoot),
      /missing or not a regular file/u,
    );
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }

  const proofRoot = await mkdtemp(join(tmpdir(), 'capture-ocr-only-proof-wire-'));
  try {
    await writeFile(join(proofRoot, 'ocr-device-proof-v1.json'), `${canonicalJson(executionProofFixture())}\n`);
    const callOrder: string[] = [];
    const expected = {
      sourceKind: 'pdf' as const,
      sourceSha256: 'd'.repeat(64),
      runtimeSha256: 'e'.repeat(64),
      workerSha256: 'f'.repeat(64),
      contractSha256: '3'.repeat(64),
    };
    const verified = await verifyInstalledOcrExecutionProof({
      artifactRoot: proofRoot,
      expected,
      readProof: async (root) => {
        callOrder.push('readProof');
        return readOcrExecutionProof(root);
      },
      assertMatches: (proof, exp) => {
        callOrder.push('assertMatches');
        assertOcrExecutionProofMatchesInstalledJourney(proof, exp);
      },
    });
    assert.deepEqual(callOrder, ['readProof', 'assertMatches']);
    assert.equal(verified.sourceSha256, expected.sourceSha256);

    await assert.rejects(
      () => verifyInstalledOcrExecutionProof({
        artifactRoot: proofRoot,
        expected: { ...expected, workerSha256: '0'.repeat(64) },
      }),
      /worker digest/u,
    );
  } finally {
    await rm(proofRoot, { recursive: true, force: true });
  }
});

test('OCR polling waits until captureId clears and durable checkpoint settles at awaiting_confirmation / awaiting_structuring', async () => {
  const row = {
    getAttribute: async (name: string) => name === 'data-user-status' ? 'done' : 'document-1',
  } as unknown as ReturnType<Page['locator']>;
  const page = {} as unknown as Page;
  let detailReads = 0;
  const result = await waitForDesktopOcrCompletion(page, row, 1_000, {
    documentId: 'document-1',
    durableCompletion: 'ocr-checkpoint',
    observeLiveness: async () => ({
      appAlive: true,
      runtimeAlive: true,
      cdpOpen: true,
      teardownRequested: false,
      appExitCode: null,
      appSignal: null,
    }),
    reattach: async () => ({ browser: {} as never, page }),
    exactOcrQueueRow: () => row,
    readDurableDetail: async () => {
      detailReads += 1;
      if (detailReads === 1) {
        return { status: 'completed', stage: 'extracting', captureId: 'cap-1' };
      }
      return { status: 'awaiting_confirmation', stage: 'awaiting_structuring', captureId: null };
    },
  });
  assert.equal(result.page, page);
  assert.equal(result.row, row);
  assert.equal(detailReads, 2);
});

test('OCR polling accepts completed-with-raw only when durableCompletion allows it', async () => {
  const row = {
    getAttribute: async (name: string) => name === 'data-user-status' ? 'done' : 'document-1',
  } as unknown as ReturnType<Page['locator']>;
  const page = {} as unknown as Page;
  const baseRecovery = {
    documentId: 'document-1',
    observeLiveness: async () => ({
      appAlive: true,
      runtimeAlive: true,
      cdpOpen: true,
      teardownRequested: false,
      appExitCode: null,
      appSignal: null,
    }),
    reattach: async () => ({ browser: {} as never, page }),
    exactOcrQueueRow: () => row,
    readDurableDetail: async () => ({
      status: 'completed',
      stage: 'completed',
      captureId: null,
      raw: { segments: [] },
      result: { blocks: [] },
    }),
  };

  await assert.rejects(
    waitForDesktopOcrCompletion(page, row, 250, {
      ...baseRecovery,
      durableCompletion: 'ocr-checkpoint',
    }),
    /awaiting_confirmation \/ awaiting_structuring/u,
  );

  const allowed = await waitForDesktopOcrCompletion(page, row, 250, {
    ...baseRecovery,
    durableCompletion: 'ocr-checkpoint-or-completed',
  });
  assert.equal(allowed.row, row);
});

test('OCR polling reads durable failure code when queue row enters needs-attention', async () => {
  const row = {
    getAttribute: async (name: string) => name === 'data-user-status' ? 'needs-attention' : 'document-1',
  } as unknown as ReturnType<Page['locator']>;
  const page = {} as unknown as Page;

  await assert.rejects(
    waitForDesktopOcrCompletion(page, row, 250, {
      documentId: 'document-1',
      durableCompletion: 'ocr-checkpoint',
      observeLiveness: async () => ({
        appAlive: true,
        runtimeAlive: true,
        cdpOpen: true,
        teardownRequested: false,
        appExitCode: null,
        appSignal: null,
      }),
      reattach: async () => ({ browser: {} as never, page }),
      exactOcrQueueRow: () => row,
      readDurableDetail: async () => ({ status: 'failed', errorCode: 'ocr_worker_failed' }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrTerminalFailure);
      assert.equal(isRealOcrWorkerFailure(error), true);
      return true;
    },
  );
});

test('real desktop OCR cleanup owns only UUID-named smoke documents', () => {
  assert.equal(
    isOwnedSmokeDocumentName(
      'standalone-real-ocr-099eca42-23f6-42ca-a3f6-05da5afd00ba.pdf',
    ),
    true,
  );
  assert.equal(
    isOwnedSmokeDocumentName(
      'standalone-real-ocr-099eca42-23f6-42ca-a3f6-05da5afd00ba.jpeg',
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

test('acceptance NSIS packaging is feature-gated and output-separated from release NSIS', async () => {
  const projectText = await readFile(new URL('../project.json', import.meta.url), 'utf8');
  const project = JSON.parse(projectText) as {
    targets?: Record<string, { outputs?: string[]; options?: { commands?: string[]; command?: string } }>;
  };
  const release = project.targets?.['build-nsis'];
  const acceptance = project.targets?.['build-nsis-acceptance'];
  const releaseCommand = JSON.stringify(release);
  const acceptanceCommand = JSON.stringify(acceptance);
  assert.match(releaseCommand, /--bundles nsis/u);
  assert.doesNotMatch(releaseCommand, /acceptance-harness/u);
  assert.match(acceptanceCommand, /build-acceptance-nsis\.ts/u);
  assert.match(acceptanceCommand, /output\/acceptance-nsis/u);
  assert.doesNotMatch(acceptanceCommand, /src-tauri[\\/]target[\\/].*bundle[\\/]nsis/u);
  assert.notEqual(acceptance, undefined);
  assert.notDeepEqual(acceptance?.outputs, release?.outputs);
});

test('packaged desktop entrypoint points at the built workbench frontend', async () => {
  const tauriConfigText = await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');
  const tauriConfig = JSON.parse(tauriConfigText) as {
    build?: { frontendDist?: string };
  };
  assert.match(tauriConfig.build?.frontendDist ?? '', /dist\/apps\/capture-workbench\/browser/u);
});

test('desktop page acquisition reconnects after a CDP attachment has no Tauri page without changing routes', async () => {
  const attachedSelectors: string[] = [];
  const page = {
    url: () => 'http://tauri.localhost/ocr',
    getByTestId: (testId: string) => ({
      waitFor: async () => {
        attachedSelectors.push(testId);
      },
    }),
  } as unknown as Page;
  let staleClosed = 0;
  let connectionCount = 0;
  const connections: Browser[] = [
    {
      contexts: () => [{ pages: () => [] }],
      close: async () => {
        staleClosed += 1;
      },
    } as unknown as Browser,
    {
      contexts: () => [{ pages: () => [page] }],
      close: async () => undefined,
    } as unknown as Browser,
  ];

  const attached = await connectToPackagedPage(64333, {
    timeoutMs: 250,
    pollIntervalMs: 1,
    connect: async () => {
      connectionCount += 1;
      return connections.shift() as Browser;
    },
  });

  assert.equal(attached.page, page);
  assert.deepEqual(attachedSelectors, ['app-shell']);
  assert.equal(connectionCount, 2);
  assert.equal(staleClosed, 1);
});

test('OCR polling reattaches once after target loss and preserves the imported document identity', async () => {
  const documentId = 'document-keep-identity';
  const oldPage = {} as Page;
  const newPage = {} as Page;
  let rowReads = 0;
  const oldRow = {
    getAttribute: async () => {
      rowReads += 1;
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  const newRow = {
    waitFor: async () => undefined,
    count: async () => 1,
    getAttribute: async (name: string) => name === 'data-document-id' ? documentId : 'done',
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  const result = await waitForDesktopOcrCompletion(
    oldPage,
    oldRow,
    250,
    {
      documentId,
      durableCompletion: 'ocr-checkpoint',
      observeLiveness: async () => ({
        appAlive: true,
        runtimeAlive: true,
        cdpOpen: true,
        teardownRequested: false,
        appExitCode: null,
        appSignal: null,
      }),
      reattach: async () => {
        reattachCount += 1;
        return { browser: {} as never, page: newPage };
      },
      exactOcrQueueRow: (page, targetId) => {
        assert.equal(page, newPage);
        assert.equal(targetId, documentId);
        return newRow;
      },
      readDurableDetail: async () => ({
        status: 'awaiting_confirmation',
        stage: 'awaiting_structuring',
        captureId: null,
      }),
    },
  );

  assert.equal(rowReads, 1);
  assert.equal(reattachCount, 1);
  assert.equal(result.page, newPage);
  assert.equal(result.row, newRow);
});

test('OCR polling fails with typed lifecycle evidence when the host dies and never reattaches', async () => {
  const oldRow = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldRow, 250, {
      documentId: 'document-keep-identity',
      durableCompletion: 'ocr-checkpoint',
      observeLiveness: async () => ({
        appAlive: false,
        runtimeAlive: true,
        cdpOpen: true,
        teardownRequested: false,
        appExitCode: 17,
        appSignal: null,
      }),
      reattach: async () => {
        reattachCount += 1;
        return { browser: {} as never, page: {} as Page };
      },
      exactOcrQueueRow: () => oldRow,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrLifecycleFailure);
      assert.equal(error.kind, 'host-lifecycle');
      assert.equal(error.liveness.appExitCode, 17);
      return true;
    },
  );
  assert.equal(reattachCount, 0);
});

test('OCR polling rejects a reattached row whose document identity changed', async () => {
  const oldRow = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  const changedRow = {
    waitFor: async () => undefined,
    count: async () => 1,
    getAttribute: async (name: string) => name === 'data-document-id' ? 'different-document' : 'done',
  } as unknown as ReturnType<Page['locator']>;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldRow, 250, {
      documentId: 'document-keep-identity',
      durableCompletion: 'ocr-checkpoint',
      observeLiveness: async () => ({
        appAlive: true,
        runtimeAlive: true,
        cdpOpen: true,
        teardownRequested: false,
        appExitCode: null,
        appSignal: null,
      }),
      reattach: async () => ({ browser: {} as never, page: {} as Page }),
      exactOcrQueueRow: () => changedRow,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrLifecycleFailure);
      assert.equal(error.kind, 'target-loss');
      return true;
    },
  );
});

test('OCR polling fails closed after a second target loss without a second reattach', async () => {
  const oldRow = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  const reattachedRow = {
    waitFor: async () => undefined,
    count: async () => 1,
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;
  let exactRowReads = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldRow, 250, {
      documentId: 'document-keep-identity',
      durableCompletion: 'ocr-checkpoint',
      observeLiveness: async () => ({
        appAlive: true,
        runtimeAlive: true,
        cdpOpen: true,
        teardownRequested: false,
        appExitCode: null,
        appSignal: null,
      }),
      reattach: async () => {
        reattachCount += 1;
        return { browser: {} as never, page: {} as Page };
      },
      exactOcrQueueRow: () => {
        exactRowReads += 1;
        return reattachedRow;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrLifecycleFailure);
      assert.equal(error.kind, 'target-loss');
      return true;
    },
  );
  assert.equal(reattachCount, 1);
  assert.equal(exactRowReads, 1);
});

test('OCR polling fails closed with a typed runtime-root-exit when runtime liveness is lost', async () => {
  const oldRow = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldRow, 250, {
      documentId: 'document-keep-identity',
      durableCompletion: 'ocr-checkpoint',
      observeLiveness: async () => ({
        appAlive: true,
        runtimeAlive: false,
        cdpOpen: true,
        teardownRequested: false,
        appExitCode: null,
        appSignal: null,
      }),
      reattach: async () => {
        reattachCount += 1;
        return { browser: {} as never, page: {} as Page };
      },
      exactOcrQueueRow: () => oldRow,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrLifecycleFailure);
      assert.equal(error.kind, 'runtime-root-exit');
      assert.equal(error.liveness.runtimeAlive, false);
      return true;
    },
  );
  assert.equal(reattachCount, 0);
});

test('OCR polling fails closed with typed target-loss when CDP is closed', async () => {
  const oldRow = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldRow, 250, {
      documentId: 'document-keep-identity',
      durableCompletion: 'ocr-checkpoint',
      observeLiveness: async () => ({
        appAlive: true,
        runtimeAlive: true,
        cdpOpen: false,
        teardownRequested: false,
        appExitCode: null,
        appSignal: null,
      }),
      reattach: async () => {
        reattachCount += 1;
        return { browser: {} as never, page: {} as Page };
      },
      exactOcrQueueRow: () => oldRow,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrLifecycleFailure);
      assert.equal(error.kind, 'target-loss');
      assert.equal(error.liveness.cdpOpen, false);
      return true;
    },
  );
  assert.equal(reattachCount, 0);
});

test('OCR polling fails closed with typed target-loss when teardown has started', async () => {
  const oldRow = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldRow, 250, {
      documentId: 'document-keep-identity',
      durableCompletion: 'ocr-checkpoint',
      observeLiveness: async () => ({
        appAlive: true,
        runtimeAlive: true,
        cdpOpen: true,
        teardownRequested: true,
        appExitCode: null,
        appSignal: null,
      }),
      reattach: async () => {
        reattachCount += 1;
        return { browser: {} as never, page: {} as Page };
      },
      exactOcrQueueRow: () => oldRow,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrLifecycleFailure);
      assert.equal(error.kind, 'target-loss');
      assert.equal(error.liveness.teardownRequested, true);
      return true;
    },
  );
  assert.equal(reattachCount, 0);
});

test('real desktop teardown delegates ownership to native Tauri seams', async () => {
  const commands: string[] = [];
  const args: Readonly<Record<string, unknown>>[] = [];
  await requestDesktopTeardown('window-close', async (command, commandArgs) => {
    commands.push(command);
    args.push(commandArgs);
  });
  assert.deepEqual(commands, ['desktop_acceptance_close_window']);
  assert.deepEqual(args, [{}]);

  await requestDesktopTeardown('terminate-process', async (command, commandArgs) => {
    commands.push(command);
    args.push(commandArgs);
    throw new Error('Target page, context or browser has been closed.');
  });
  assert.deepEqual(commands, [
    'desktop_acceptance_close_window',
    'desktop_acceptance_terminate_root',
  ]);
  assert.deepEqual(args, [{}, {}]);
  await assert.rejects(
    requestDesktopTeardown('terminate-process', async () => {
      throw new Error('native termination failed with code 5');
    }),
    /native termination failed with code 5/u,
  );
});

test('real desktop OCR observer fails fast on terminal status with a sanitized code', () => {
  assert.equal(realDesktopTeardownTimeoutMs, 15_000);
  assert.equal(
    safeTerminalDesktopOcrFailure('failed', 'ocr_worker_failed'),
    'Standalone desktop OCR terminated. status=failed; errorCode=ocr_worker_failed.',
  );
  assert.equal(
    safeTerminalDesktopOcrFailure('cancelled', 'INVALID CODE'),
    'Standalone desktop OCR terminated. status=cancelled; errorCode=unknown.',
  );
  assert.equal(safeTerminalDesktopOcrFailure('processing', 'ocr_worker_failed'), undefined);
});

test('real OCR failure classification uses typed terminal observation, not message wording', () => {
  const typedFailure = new DesktopOcrTerminalFailure(
    { status: 'failed', errorCode: 'ocr_worker_failed' },
    'wording changed by the desktop shell',
  );
  assert.equal(isRealOcrWorkerFailure(typedFailure), true);
  assert.equal(
    isRealOcrWorkerFailure(
      new DesktopOcrTerminalFailure({ status: 'failed', errorCode: 'cancelled' }),
    ),
    false,
  );
  assert.equal(
    isRealOcrWorkerFailure(new Error('Standalone desktop OCR terminated. status=failed; errorCode=ocr_worker_failed.')),
    false,
  );
});

test('real desktop teardown is bounded and leaves cleanup unproven on timeout', async () => {
  await assert.rejects(
    requestDesktopTeardown('window-close', () => new Promise<never>(() => undefined), 5),
    /Native desktop teardown timed out; cleanup is unproven\./u,
  );
});

test('real desktop teardown rejects unknown modes instead of selecting a PID fallback', () => {
  assert.equal(resolveDesktopTeardownMode(undefined), 'window-close');
  assert.equal(resolveDesktopTeardownMode('terminate-process'), 'terminate-process');
  assert.throws(
    () => resolveDesktopTeardownMode('taskkill'),
    /CAPTURE_REAL_DESKTOP_TEARDOWN must be window-close or terminate-process/u,
  );
});

test('OCR screenshot evidence masks whole privacy-sensitive result panes and metadata', async () => {
  const selectors: string[] = [];
  const testIds: string[] = [];
  let capturedOptions: { mask?: unknown[] } | undefined;
  const events: string[] = [];
  const fakePage = {
    locator: (selector: string) => {
      selectors.push(selector);
      return { kind: 'locator', selector };
    },
    getByTestId: (testId: string) => {
      testIds.push(testId);
      return { kind: 'testId', testId };
    },
    screenshot: async (options: { mask?: unknown[] }) => {
      events.push('screenshot');
      capturedOptions = options;
      return Buffer.alloc(0);
    },
  } as unknown as Page;
  const screenshots: string[] = [];
  const acceptance = { artifactRoot: 'C:\\artifacts' } as unknown as Parameters<typeof acceptanceScreenshot>[1];

  await acceptanceScreenshot(
    fakePage,
    acceptance,
    screenshots,
    '01-consent-required',
    async () => {
      events.push('checkpoint');
    },
  );

  assert.equal(selectors.includes('.review-block pre'), false);
  assert.ok(testIds.includes('result-source-pane'));
  assert.ok(testIds.includes('result-text-pane'));
  assert.ok(testIds.includes('result-title'));
  assert.ok(testIds.includes('diagnostics-document-filename'));
  assert.deepEqual(events, ['screenshot', 'checkpoint']);
  assert.deepEqual(
    capturedOptions?.mask,
    [
      { kind: 'locator', selector: 'time' },
      { kind: 'locator', selector: '.dynamic-id' },
      { kind: 'testId', testId: 'result-title' },
      { kind: 'testId', testId: 'result-detail-filename' },
      { kind: 'testId', testId: 'diagnostics-document-filename' },
      { kind: 'locator', selector: '[data-testid="ocr-queue-row"] td:first-child' },
      { kind: 'locator', selector: '[data-testid="history-row"] td:nth-child(2)' },
      { kind: 'testId', testId: 'result-source-pane' },
      { kind: 'testId', testId: 'result-text-pane' },
    ],
  );
  assert.deepEqual(screenshots, [join('C:\\artifacts', '01-consent-required.png')]);
});

test('real desktop OCR provenance requires the PaddleOCR engine', () => {
  assert.deepEqual(
    parseOcrProvenance({
      engine: 'windowsml-ocr',
      model: 'pp-ocrv6-medium-windowsml',
      device: 'windowsml-dml',
    }),
    {
      engine: 'windowsml-ocr',
      model: 'pp-ocrv6-medium-windowsml',
      device: 'windowsml-dml',
    },
  );
  assert.throws(
    () => parseOcrProvenance({
      engine: 'pdf-embedded',
      model: 'legacy',
      device: 'cpu',
    }),
    /recognized OCR device provenance/u,
  );
});

test('first-run OCR setup unchecks ASR and speakers, retries once on filesystem failure, and returns to /ocr', async () => {
  let route: 'ocr' | 'settings-engines' = 'ocr';
  let ocrChecked = false;
  let asrChecked = true;
  let speakersChecked = true;
  let installClicks = 0;
  let retryClicks = 0;
  let detailsExpanded = false;
  let ocrEngineStatus: 'installable' | 'running' | 'failed' | 'ready' = 'installable';
  let pollCount = 0;
  const events: string[] = [];

  const testIdLocator = (testId: string) => ({
    waitFor: async () => undefined,
    isVisible: async () => {
      if (testId === 'page-ocr') return route === 'ocr';
      if (testId === 'page-settings-engines') return route === 'settings-engines';
      if (testId === 'first-run-card') return route === 'ocr' && ocrEngineStatus === 'installable';
      if (testId === 'first-run-checkbox-ocr' || testId === 'first-run-checkbox-asr' || testId === 'first-run-checkbox-speakers') {
        return route === 'ocr' && ocrEngineStatus === 'installable';
      }
      if (testId === 'diagnostics-runtime-error') return false;
      return route === 'ocr';
    },
    isEnabled: async () => {
      if (testId === 'first-run-install') return ocrChecked && !asrChecked && !speakersChecked;
      return true;
    },
    count: async () => (testId.startsWith('first-run-checkbox-') && ocrEngineStatus !== 'installable' ? 0 : 1),
    isChecked: async () => {
      if (testId === 'first-run-checkbox-ocr') return ocrChecked;
      if (testId === 'first-run-checkbox-asr') return asrChecked;
      if (testId === 'first-run-checkbox-speakers') return speakersChecked;
      return false;
    },
    check: async () => {
      if (testId === 'first-run-checkbox-ocr') ocrChecked = true;
    },
    uncheck: async () => {
      if (testId === 'first-run-checkbox-asr') asrChecked = false;
      if (testId === 'first-run-checkbox-speakers') speakersChecked = false;
    },
    click: async () => {
      if (testId === 'first-run-install') {
        assert.equal(ocrChecked, true);
        assert.equal(asrChecked, false);
        assert.equal(speakersChecked, false);
        installClicks += 1;
        ocrEngineStatus = 'failed';
      } else if (testId === 'nav-settings') {
        route = 'settings-engines';
      } else if (testId === 'nav-ocr') {
        route = 'ocr';
      }
    },
    getAttribute: async (name: string) => {
      if (testId === 'runtime-status' && name === 'data-state') return 'ready';
      return null;
    },
    textContent: async () => null,
    evaluateAll: async () => (testId === 'engine-row'
      ? [{ id: 'windowsml-ocr', status: ocrEngineStatus, text: 'OCR' }]
      : []),
  });

  const engineRowLocator = {
    waitFor: async () => undefined,
    getAttribute: async (name: string) => {
      if (name !== 'data-status') return null;
      pollCount += 1;
      if (pollCount >= 2 && retryClicks === 1) ocrEngineStatus = 'ready';
      return ocrEngineStatus;
    },
    textContent: async () => 'OCR engine',
    getByTestId: (childId: string) => {
      if (childId === 'engine-row-toggle') {
        return {
          click: async () => {
            detailsExpanded = true;
          },
        };
      }
      if (childId === 'engine-row-retry') {
        return {
          isEnabled: async () => true,
          click: async () => {
            retryClicks += 1;
            ocrEngineStatus = 'running';
          },
        };
      }
      return {};
    },
  };

  const engineDetailsLocator = {
    isVisible: async () => detailsExpanded && ocrEngineStatus === 'failed',
    getByTestId: (childId: string) => ({
      textContent: async () => (childId === 'engine-row-error' ? 'Transient disk lock' : ''),
    }),
  };

  const fakePage = {
    url: () => (route === 'ocr' ? 'http://tauri.localhost/ocr' : 'http://tauri.localhost/settings/engines'),
    getByTestId: testIdLocator,
    locator: (selector: string) => {
      if (selector === '[data-testid="engine-row"][data-requirement-id="windowsml-ocr"]') return engineRowLocator;
      if (selector === '[data-testid="engine-row-details"][data-requirement-id="windowsml-ocr"]') return engineDetailsLocator;
      return {};
    },
    evaluate: async (_fn: unknown, payload: { readonly commandName?: string }) => {
      if (payload?.commandName === 'runtime_requirements') {
        return { items: [{ requirementId: 'windowsml-ocr', status: 'installable' }] };
      }
      if (payload?.commandName === 'runtime_list_installations') {
        return {
          items: ocrEngineStatus === 'failed'
            ? [{
                requirementId: 'windowsml-ocr',
                status: 'failed',
                error: { code: 'installation_filesystem', message: 'Transient disk lock' },
              }]
            : [],
        };
      }
      return {};
    },
  } as unknown as Page;

  const result = await runOcrFirstRunSetup(fakePage, {
    onConsentRequired: async () => { events.push('consent'); },
    onInstallStarted: () => { events.push('install-started'); },
    onInstallProgress: async () => { events.push('install-progress'); },
    onInstallRetry: async () => { events.push('install-retry'); },
  });

  assert.deepEqual(result, { installRequired: true });
  assert.equal(installClicks, 1);
  assert.equal(retryClicks, 1);
  assert.equal(route, 'ocr');
  assert.deepEqual(events, ['consent', 'install-started', 'install-progress', 'install-started', 'install-retry']);
});

test('first-run OCR setup handles already-ready, active-installation, dismissed-card, and non-filesystem failure paths', async () => {
  const readyPage = {
    url: () => 'http://tauri.localhost/ocr',
    getByTestId: (id: string) => ({
      waitFor: async () => undefined,
      isVisible: async () => id === 'page-ocr',
      getAttribute: async () => (id === 'runtime-status' ? 'ready' : null),
      evaluateAll: async () => [],
    }),
    evaluate: async (_fn: unknown, payload: { readonly commandName?: string }) => (
      payload?.commandName === 'runtime_requirements'
        ? { items: [{ requirementId: 'windowsml-ocr', status: 'ready' }] }
        : { items: [] }
    ),
  } as unknown as Page;

  assert.equal(await readWindowsMlOcrRequirementStatus(readyPage), 'ready');
  assert.deepEqual(await runOcrFirstRunSetup(readyPage), { installRequired: false });
  await assert.rejects(
    () => runOcrFirstRunSetup(readyPage, { failIfAlreadyReady: true }),
    /unexpectedly started already ready/u,
  );

  // Dismissed card falls back to /settings/engines when !failIfAlreadyReady and fails when failIfAlreadyReady.
  let dismissedRoute: 'ocr' | 'settings-engines' = 'ocr';
  let rowInstallClicks = 0;
  let dismissedStatus: 'installable' | 'ready' = 'installable';
  const dismissedRow = {
    waitFor: async () => undefined,
    getAttribute: async () => dismissedStatus,
    textContent: async () => 'OCR',
    getByTestId: (childId: string) => ({
      isEnabled: async () => true,
      click: async () => {
        if (childId === 'engine-row-install') {
          rowInstallClicks += 1;
          dismissedStatus = 'ready';
        }
      },
    }),
  };
  const dismissedPage = {
    url: () => (dismissedRoute === 'ocr' ? 'http://tauri.localhost/ocr' : 'http://tauri.localhost/settings/engines'),
    getByTestId: (id: string) => ({
      waitFor: async () => undefined,
      isVisible: async () => {
        if (id === 'page-ocr') return dismissedRoute === 'ocr';
        if (id === 'page-settings-engines') return dismissedRoute === 'settings-engines';
        return false;
      },
      click: async () => {
        if (id === 'nav-settings') dismissedRoute = 'settings-engines';
        if (id === 'nav-ocr') dismissedRoute = 'ocr';
      },
      getAttribute: async () => (id === 'runtime-status' ? 'ready' : null),
      evaluateAll: async () => [],
    }),
    locator: (selector: string) => (
      selector === '[data-testid="engine-row"][data-requirement-id="windowsml-ocr"]' ? dismissedRow : {}
    ),
    evaluate: async (_fn: unknown, payload: { readonly commandName?: string }) => (
      payload?.commandName === 'runtime_requirements'
        ? { items: [{ requirementId: 'windowsml-ocr', status: 'installable' }] }
        : { items: [] }
    ),
  } as unknown as Page;

  await assert.rejects(
    () => runOcrFirstRunSetup(dismissedPage, { failIfAlreadyReady: true, firstRunCardTimeoutMs: 20 }),
    /did not present the text recognition card/u,
  );
  assert.deepEqual(
    await runOcrFirstRunSetup(dismissedPage, { firstRunCardTimeoutMs: 20 }),
    { installRequired: true },
  );
  assert.equal(rowInstallClicks, 1);

  // Active/failed installation goes straight to Settings › Engines and fails with sanitized host code + message.
  let activeRoute: 'ocr' | 'settings-engines' = 'ocr';
  let detailsShown = false;
  const failingRow = {
    waitFor: async () => undefined,
    getAttribute: async () => 'failed',
    textContent: async () => 'OCR row',
    getByTestId: (childId: string) => ({
      click: async () => {
        if (childId === 'engine-row-toggle') detailsShown = true;
      },
    }),
  };
  const activeFailingPage = {
    url: () => (activeRoute === 'ocr' ? 'http://tauri.localhost/ocr' : 'http://tauri.localhost/settings/engines'),
    getByTestId: (id: string) => ({
      waitFor: async () => undefined,
      isVisible: async () => (id === 'page-ocr' ? activeRoute === 'ocr' : activeRoute === 'settings-engines'),
      click: async () => {
        if (id === 'nav-settings') activeRoute = 'settings-engines';
      },
      getAttribute: async () => (id === 'runtime-status' ? 'ready' : null),
      evaluateAll: async () => [],
    }),
    locator: (selector: string) => {
      if (selector === '[data-testid="engine-row"][data-requirement-id="windowsml-ocr"]') return failingRow;
      if (selector === '[data-testid="engine-row-details"][data-requirement-id="windowsml-ocr"]') {
        return {
          isVisible: async () => detailsShown,
          getByTestId: () => ({ textContent: async () => 'Checksum mismatch while downloading OCR pack' }),
        };
      }
      return {};
    },
    evaluate: async (_fn: unknown, payload: { readonly commandName?: string }) => {
      if (payload?.commandName === 'runtime_requirements') {
        return { items: [{ requirementId: 'windowsml-ocr', status: 'installable' }] };
      }
      if (payload?.commandName === 'runtime_list_installations') {
        return {
          items: [{
            requirementId: 'windowsml-ocr',
            status: 'failed',
            error: { code: 'download_failed', message: 'Checksum mismatch while downloading OCR pack' },
          }],
        };
      }
      return {};
    },
  } as unknown as Page;

  await assert.rejects(
    () => runOcrFirstRunSetup(activeFailingPage, { firstRunCardTimeoutMs: 20 }),
    /status=failed; errorCode=download_failed: Checksum mismatch while downloading OCR pack/u,
  );
  assert.equal(activeRoute, 'settings-engines');
  assert.equal(detailsShown, true);
});

test('Settings › Compute observation navigates cleanly and supports DML and CPU variants', async () => {
  for (const scenario of [
    { targetTestId: 'ocr-compute-status', modeAttr: 'gpu-dml', expected: { visible: true, mode: 'gpu-dml' } },
    { targetTestId: 'ocr-compute-notice', modeAttr: 'cpu-fallback', expected: { visible: true, mode: 'cpu-fallback' } },
    { targetTestId: 'compute-ocr-detected', modeAttr: null, expected: { visible: true, mode: 'cpu-fallback' } },
  ] as const) {
    let route: 'ocr' | 'settings-compute' = 'ocr';
    const section = {
      waitFor: async () => undefined,
      locator: () => ({
        first: () => ({
          isVisible: async () => scenario.targetTestId !== 'compute-ocr-detected',
          getAttribute: async () => scenario.modeAttr,
        }),
      }),
      getByTestId: (id: string) => ({
        isVisible: async () => id === scenario.targetTestId,
      }),
    };
    const fakePage = {
      getByTestId: (id: string) => {
        if (id === 'compute-ocr-section') return section;
        return {
          waitFor: async () => undefined,
          isVisible: async () => (id === 'page-ocr' ? route === 'ocr' : route === 'settings-compute'),
          click: async () => {
            if (id === 'settings-nav-compute') route = 'settings-compute';
            if (id === 'nav-ocr') route = 'ocr';
          },
        };
      },
    } as unknown as Page;

    const observed = await readOcrComputeModeFromSettings(fakePage);
    assert.deepEqual(observed, scenario.expected);
    assert.equal(route, 'ocr');
  }
});

test('multi-page OCR result and diagnostics provenance verification', async () => {
  let currentPage = 1;
  let route: 'content' | 'details' | 'diagnostics' = 'content';
  const pageTexts = new Map([[1, 'Page one OCR line'], [2, 'Page two OCR line']]);

  const fakePage = {
    getByTestId: (id: string) => ({
      waitFor: async () => undefined,
      isVisible: async () => true,
      isEnabled: async () => true,
      count: async () => 1,
      inputValue: async () => pageTexts.get(currentPage) ?? '',
      textContent: async () => (id === 'result-page-indicator' ? `${currentPage} / 2` : null),
      getAttribute: async (attr: string) => {
        if (id === 'diagnostics-document' && attr === 'data-document-id') return 'doc-1';
        if (id === 'diagnostics-extraction-provenance') {
          if (attr === 'data-engine') return 'windowsml-ocr';
          if (attr === 'data-model') return 'pp-ocrv6-medium-windowsml';
          if (attr === 'data-device') return 'windowsml-dml';
          if (attr === 'data-digest') return 'a'.repeat(64);
        }
        return null;
      },
      click: async () => {
        if (id === 'result-page-next') currentPage += 1;
        if (id === 'result-nav-details') route = 'details';
        if (id === 'result-detail-diagnostics') route = 'diagnostics';
      },
    }),
  } as unknown as Page;

  const visible = await readAndAssertVisibleOcrPages(fakePage, [
    { page: 1, text: 'Page one OCR line' },
    { page: 2, text: 'Page two OCR line' },
  ]);
  assert.equal(visible.rawText, 'Page one OCR line\nPage two OCR line');

  const provenance = await readOcrProvenance(fakePage, 'doc-1');
  assert.equal(route, 'diagnostics');
  assert.deepEqual(provenance, {
    engine: 'windowsml-ocr',
    model: 'pp-ocrv6-medium-windowsml',
    device: 'windowsml-dml',
    digest: 'a'.repeat(64),
  });

  const durableSegments = extractDurableOcrSegments({
    raw: {
      segments: [
        { segmentId: 'seg-1', order: 0, locator: { kind: 'page', page: 1 }, text: 'Page one OCR line' },
        { segmentId: 'seg-2', order: 1, locator: { kind: 'page', page: 2 }, text: 'Page two OCR line' },
      ],
    },
  });
  assert.equal(durableSegments.length, 2);
  const durable = readDurableOcrProvenance({
    raw: {
      extractionEngine: {
        engine: 'windowsml-ocr',
        model: 'pp-ocrv6-medium-windowsml',
        device: 'windowsml-dml',
        digest: 'a'.repeat(64),
      },
    },
  });
  assert.deepEqual(durable, {
    engine: 'windowsml-ocr',
    model: 'pp-ocrv6-medium-windowsml',
    device: 'windowsml-dml',
    digest: 'a'.repeat(64),
  });

  const extractionDigest = 'b'.repeat(64);
  const evidenceDigest = 'c'.repeat(64);
  let renderedEvidenceDigest = evidenceDigest;
  const diagnosticsFakePage = {
    getByTestId: (id: string) => ({
      waitFor: async () => undefined,
      isVisible: async () => id === 'diagnostics-evidence-digest',
      textContent: async () => (id === 'diagnostics-evidence-digest' ? renderedEvidenceDigest : null),
      getAttribute: async (attr: string) => {
        if (id === 'diagnostics-document' && attr === 'data-document-id') return 'doc-1';
        if (id === 'diagnostics-extraction-provenance') {
          if (attr === 'data-engine') return 'windowsml-ocr';
          if (attr === 'data-model') return 'pp-ocrv6-medium-windowsml';
          if (attr === 'data-device') return 'windowsml-dml';
          if (attr === 'data-digest') return extractionDigest;
        }
        return null;
      },
      click: async () => undefined,
    }),
  } as unknown as Page;

  const matchingDetail = {
    raw: {
      extractionEngine: {
        engine: 'windowsml-ocr',
        model: 'pp-ocrv6-medium-windowsml',
        device: 'windowsml-dml',
        digest: extractionDigest,
      },
    },
    ocrEvidence: {
      digest: evidenceDigest,
    },
  };
  await assertDiagnosticsMatchesDurableOcr(diagnosticsFakePage, matchingDetail, 'doc-1');

  renderedEvidenceDigest = 'd'.repeat(64);
  await assert.rejects(
    () => assertDiagnosticsMatchesDurableOcr(diagnosticsFakePage, matchingDetail, 'doc-1'),
    /evidence digest/u,
  );
  renderedEvidenceDigest = evidenceDigest;
  await assert.rejects(
    () => assertDiagnosticsMatchesDurableOcr(
      diagnosticsFakePage,
      {
        ...matchingDetail,
        raw: {
          extractionEngine: {
            engine: 'windowsml-ocr',
            model: 'pp-ocrv6-medium-windowsml',
            device: 'windowsml-dml',
            digest: 'e'.repeat(64),
          },
        },
      },
      'doc-1',
    ),
    /extraction digest/u,
  );
});

test('deleteCompletedDocument deletes from /history and confirms removal via library_list', async () => {
  let deletedInUi = false;
  let libraryRecords: Array<{ readonly documentId: string; readonly fileName: string }> = [
    { documentId: 'doc-delete', fileName: 'sample.pdf' },
  ];
  let listCalls = 0;

  const historyRow = {
    count: async () => (deletedInUi ? 0 : 1),
    getAttribute: async (name: string) => {
      if (name === 'data-document-id') return 'doc-delete';
      if (name === 'data-user-status') return 'done';
      return null;
    },
    locator: () => ({ textContent: async () => 'sample.pdf' }),
    getByTestId: () => ({
      isEnabled: async () => true,
      click: async () => undefined,
    }),
    waitFor: async ({ state }: { readonly state?: string }) => {
      if (state === 'hidden') deletedInUi = true;
    },
  };

  const fakePage = {
    locator: (selector: string) => {
      if (selector === '[data-testid="history-row"][data-document-id="doc-delete"]') return historyRow;
      return { getByText: () => ({}) };
    },
    getByTestId: (id: string) => ({
      isVisible: async () => id === 'page-history' || id === 'history-table',
      waitFor: async () => undefined,
      click: async () => {
        if (id === 'history-delete-confirm') deletedInUi = true;
      },
    }),
    evaluate: async (_fn: unknown, payload: { readonly commandName?: string }) => {
      if (payload?.commandName === 'library_list') {
        listCalls += 1;
        if (listCalls >= 2) libraryRecords = [];
        return libraryRecords;
      }
      return [];
    },
  } as unknown as Page;

  assert.equal(await deleteCompletedDocument(fakePage, 'sample.pdf', 'doc-delete'), true);
  assert.equal(deletedInUi, true);
  assert.equal(listCalls, 2);
});

test('runtime error and diagnostics helpers inspect runtime-status and engine rows', async () => {
  let clickedStatus = false;
  const fakePage = {
    url: () => 'http://tauri.localhost/ocr',
    getByTestId: (id: string) => {
      if (id === 'diagnostics-runtime-error') {
        return {
          waitFor: async () => undefined,
          isVisible: async () => clickedStatus,
          textContent: async () => 'Sidecar exited unexpectedly',
        };
      }
      if (id === 'runtime-status') {
        return {
          getAttribute: async () => 'error',
          click: async () => { clickedStatus = true; },
        };
      }
      if (id === 'engine-row') {
        return {
          evaluateAll: async () => [{ id: 'windowsml-ocr', status: 'failed', text: 'OCR' }],
        };
      }
      return { isVisible: async () => false };
    },
  } as unknown as Page;

  const errorMessage = await visibleRuntimeError(fakePage);
  assert.match(errorMessage ?? '', /Sidecar exited unexpectedly/u);
  const diagnostics = JSON.parse(await runtimeSetupDiagnostics(fakePage)) as { runtimeState: string; runtimeError?: string };
  assert.equal(diagnostics.runtimeState, 'error');
  assert.equal(diagnostics.runtimeError, 'Sidecar exited unexpectedly');

  const brokenPage = {
    url: () => {
      throw new Error('page crashed');
    },
    getByTestId: () => {
      throw new Error('target closed');
    },
  } as unknown as Page;
  assert.equal(await visibleRuntimeError(brokenPage), undefined);
  assert.equal(await runtimeSetupDiagnostics(brokenPage), 'diagnostics-unavailable');
});

test('the viewport is pinned to the size the native window really has', async () => {
  const applied: Array<{ width: number; height: number }> = [];
  const page = {
    evaluate: async () => ({ width: 1280, height: 860 }),
    setViewportSize: async (size: { width: number; height: number }) => {
      applied.push(size);
    },
  } as unknown as Page;
  assert.deepEqual(await pinViewportToWindow(page), { width: 1280, height: 860 });
  assert.deepEqual(applied, [{ width: 1280, height: 860 }]);

  const unusable = {
    evaluate: async () => ({ width: 0, height: 860 }),
    setViewportSize: async () => {
      throw new Error('must not emulate an invalid viewport');
    },
  } as unknown as Page;
  await assert.rejects(pinViewportToWindow(unusable), /invalid viewport size/u);
});
