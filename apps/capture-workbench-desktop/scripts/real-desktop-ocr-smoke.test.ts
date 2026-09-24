import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser, Page } from '@playwright/test';

import {
  assertPhase1PageOnePdfSemanticEvidence,
  assertExpectedOcrDevice,
  assertOcrExecutionProofMatchesInstalledJourney,
  assertRealDesktopSmokeEvidence,
  closeOwnedDesktopRoot,
  connectToPackagedPage,
  DesktopOcrTerminalFailure,
  DesktopOcrLifecycleFailure,
  establishOwnedDesktopLaunch,
  finalizeDesktopTeardown,
  isRealOcrWorkerFailure,
  isOwnedSmokeDocumentName,
  maybeInstallStructuringModel,
  parseOcrProvenance,
  requestDesktopTeardown,
  realDesktopRuntimeReadyTimeoutMs,
  realDesktopTeardownTimeoutMs,
  resolveDesktopRuntimePreflight,
  resolveLocalInstalledRuntimeIdentity,
  resolveDesktopTeardownMode,
  resolveExpectedOcrDevice,
  scrubLocalModelEnvironment,
  safeTerminalDesktopOcrFailure,
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
      runtimeVersion: '0.4.2',
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

test('local candidate wiring keeps machine-local roots and fixed catalog digests out of tracked smoke source', async () => {
  for (const sourcePath of [
    './real-desktop-ocr-smoke.ts',
    './local-candidate-model.ts',
  ]) {
    const source = await readFile(new URL(sourcePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /[A-Z]:[\\/]/u, sourcePath);
    assert.doesNotMatch(source, /["'][a-f0-9]{64}["']/u, sourcePath);
  }
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
  const source = await readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8');
  const launch = source.indexOf('launchedApp = await establishOwnedDesktopLaunch');
  const callback = source.indexOf('spawnChild: () => {', launch);
  const assigned = source.indexOf('launchedApp = child;', callback);
  const returned = source.indexOf('return child;', assigned);
  assert.ok(launch >= 0 && callback > launch && assigned > callback && returned > assigned);
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
    runtimeVersion: '0.4.2',
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
    releaseVersion: '0.4.2',
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
      runtimeVersion: '0.4.2',
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
  assert.equal(identity.runtimeVersion, '0.4.2');
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
        runtimeVersion: '0.4.2',
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
      manifestVersion: '1', platform: 'windows', runtimeVersion: '0.4.2',
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
      manifestVersion: '1', platform: 'windows', runtimeVersion: '0.4.2',
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
    manifestVersion: '1', platform: 'windows', runtimeVersion: '0.4.2',
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
  runtimeVersion: '0.4.2',
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

test('real desktop OCR evidence requires real engines, Ollama provenance, cleanup, and redaction', () => {
  assert.equal(realDesktopRuntimeReadyTimeoutMs, 180_000);
  const valid = {
    evidenceKind: 'real-standalone-tauri-ui-ocr',
    releaseGateSatisfied: true,
    realEnginesExercised: true,
    sourceKind: 'pdf',
    rawOcrVisible: true,
    ocrResultVerified: true,
    rawOcrSegmentCount: 2,
    structuredBlockCount: 2,
    expectedAnchorCount: 4,
    matchedAnchorCount: 4,
    ocrDevice: 'windowsml-dml',
    structuringEngine: 'ollama',
    model: 'capture-workbench-qwen3.5-4b-structure-v1',
    documentDeletedAfterVerification: true,
  };

  assert.doesNotThrow(() => assertRealDesktopSmokeEvidence(valid));
  assert.throws(
    () => assertRealDesktopSmokeEvidence({ ...valid, structuringEngine: 'deterministic' }),
    /Expected values to be strictly equal/u,
  );
  assert.doesNotThrow(() => assertRealDesktopSmokeEvidence({ ...valid, model: 'capture-workbench-qwen3.5-0.8b-structure-v1' }));
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
    assert.doesNotThrow(() => assertRealDesktopSmokeEvidence(valid));
    assert.throws(
      () => assertRealDesktopSmokeEvidence({ ...valid, releaseGateSatisfied: true }),
      /Expected values to be strictly equal/u,
      'OCR proof must not be reported as structuring or release success',
    );
    assert.throws(
      () => assertRealDesktopSmokeEvidence({ ...valid, structuredBlockCount: 1 }),
      /Expected values to be strictly equal/u,
      'OCR-only evidence must not fabricate structured blocks',
    );
    assert.throws(
      () => assertRealDesktopSmokeEvidence({ ...valid, ocrExecutionProof: undefined }),
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
      assert.doesNotThrow(() => assertPhase1PageOnePdfSemanticEvidence(
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
    readonly scope?: Parameters<typeof assertPhase1PageOnePdfSemanticEvidence>[0];
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
      () => assertPhase1PageOnePdfSemanticEvidence(
        item.scope ?? validScope,
        item.semantic ?? validSemantic,
      ),
      item.error,
      item.name,
    );
  }
});

test('Phase 1 PDF semantic owner gates only OCR-only PDFs before the atomic artifact writer', async () => {
  const smokeSource = await readFile(
    new URL('./real-desktop-ocr-smoke.ts', import.meta.url),
    'utf8',
  );
  const ocrOnlyBuild = smokeSource.indexOf(
    'const semanticEvidence = buildOcrOnlySemanticEvidence',
  );
  const proofIdentityBuild = smokeSource.indexOf(
    'const proofIdentity: OcrSemanticExecutionProofIdentity',
  );
  const ocrOnlyWrite = smokeSource.indexOf(
    'semanticArtifactIdentity = await writeOcrSemanticEvidenceArtifact',
    ocrOnlyBuild,
  );
  const structuringBuild = smokeSource.indexOf(
    'const semanticEvidence = buildOcrSemanticEvidence',
    ocrOnlyWrite,
  );
  const structuringWrite = smokeSource.indexOf(
    'semanticArtifactIdentity = await writeOcrSemanticEvidenceArtifact',
    structuringBuild,
  );

  assert.ok(proofIdentityBuild >= 0 && ocrOnlyBuild > proofIdentityBuild);
  assert.match(
    smokeSource.slice(proofIdentityBuild, ocrOnlyBuild),
    /if \(acceptanceMode === 'ocr-only'\) \{\s*$/u,
    'the owner must remain in the OCR-only branch',
  );
  assert.ok(ocrOnlyBuild >= 0 && ocrOnlyWrite > ocrOnlyBuild);
  assert.match(
    smokeSource.slice(ocrOnlyBuild, ocrOnlyWrite),
    /if \(sourceKind === 'pdf'\) \{[\s\S]*assertPhase1PageOnePdfSemanticEvidence\(pdfPageScope, semanticEvidence\);\s*\}\s*$/u,
    'the PDF guard must close before the writer so image OCR-only evidence is still written',
  );
  assert.ok(structuringBuild > ocrOnlyWrite && structuringWrite > structuringBuild);
  assert.doesNotMatch(
    smokeSource.slice(structuringBuild, structuringWrite),
    /assertPhase1PageOnePdfSemanticEvidence/u,
    'the generic structuring semantic path must remain outside the Phase 1 owner gate',
  );
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
  const smokeSource = await readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8');
  const proofWiring = /acceptanceMode === ['"]ocr-only['"][\s\S]*?readOcrExecutionProof\(acceptance\.artifactRoot\)[\s\S]*?assertOcrExecutionProofMatchesInstalledJourney\(proof,/u;
  assert.ok(
    proofWiring.test(smokeSource),
    'OCR-only acceptance must read and match the real execution-proof summary before deferred structuring.',
  );
});

test('OCR-only action seam never invokes structuring-model consent', async () => {
  let installAttempts = 0;
  await maybeInstallStructuringModel('ocr-only', async () => { installAttempts += 1; });
  assert.equal(installAttempts, 0);
  await maybeInstallStructuringModel('structuring', async () => { installAttempts += 1; });
  assert.equal(installAttempts, 1);
});

test('OCR-only polling stops at the durable awaiting_structuring checkpoint without reading a result', async () => {
  let clicks = 0;
  const card = {
    getAttribute: async (name: string) => name === 'data-status' ? 'awaiting_confirmation' : 'document-1',
    click: async () => { clicks += 1; },
  } as unknown as ReturnType<Page['locator']>;
  const page = {
    locator: (selector: string) => {
      assert.equal(selector, '.stage-line');
      return { getAttribute: async (name: string) => name === 'data-stage' ? 'awaiting_structuring' : null };
    },
  } as unknown as Page;
  const result = await waitForDesktopOcrCompletion(page, card, 250, {
    fileName: 'source.pdf',
    documentId: 'document-1',
    stopAtOcrCheckpoint: true,
    observeLiveness: async () => ({
      appAlive: true,
      runtimeAlive: true,
      cdpOpen: true,
      teardownRequested: false,
      appExitCode: null,
      appSignal: null,
    }),
    reattach: async () => ({ browser: {} as never, page }),
    exactDocumentCard: () => card,
  });
  assert.equal(result.page, page);
  assert.equal(result.card, card);
  assert.equal(clicks, 1);
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

test('exact-artifact acceptance opens the supplied source without creating a picker fixture', async () => {
  const source = await readFile(
    new URL('./real-desktop-ocr-smoke.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /const pickerSourcePath = acceptance\s*\n\s*\? sourcePath\s*\n\s*:\s*join\(outputDirectory, sourceName\)/u);
  assert.match(source, /if \(!acceptance\) await writeFile\(pickerSourcePath, sourceBytes\)/u);
  assert.match(source, /if \(!acceptance\) \{\s*\n\s*await rm\(pickerSourcePath/u);
});

test('only the explicit packaged PDF acceptance run advertises page one', async () => {
  const [smokeSource, captureSource, runtimeSource, workerSource] = await Promise.all([
    readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../apps/capture-workbench/src/app/services/desktop-workspace-capture.service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../apps/capture-workbench/src/app/services/desktop-runtime-client.service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../packages/capture-runtime/src/capture_runtime/workers/ocr_main.py', import.meta.url), 'utf8'),
  ]);
  assert.match(
    smokeSource,
    /acceptance && sourceKind === 'pdf'[\s\S]*CAPTURE_ACCEPTANCE_PDF_PAGE_SCOPE: 'page-1'/u,
  );
  assert.match(captureSource, /isPdfDocument\(documentId, host, mediaType\)[\s\S]*this\.runtime\.pdfPageNumbers\(\)/u);
  assert.doesNotMatch(captureSource, /isPdfDocument\(documentId, host, mediaType\)\s*\?\s*\[1\]/u);
  assert.match(runtimeSource, /value\.length >= 1[\s\S]*value\.every\(\(page, index\) => page === index \+ 1\)/u);
  assert.match(workerSource, /tuple\(range\(1, page_count \+ 1\)\) if page_numbers is None/u);
});

test('installed acceptance wires the private OCR proof from run root to manifest', async () => {
  const [smokeSource, launchPolicy, runtimeConfig, ocrWorker, streamingService, acceptanceContract] = await Promise.all([
    readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/launch_policy.rs', import.meta.url), 'utf8'),
    readFile(new URL('../../../packages/capture-runtime/src/capture_runtime/config.py', import.meta.url), 'utf8'),
    readFile(new URL('../../../packages/capture-runtime/src/capture_runtime/workers/ocr_main.py', import.meta.url), 'utf8'),
    readFile(new URL('../../../packages/capture-runtime/src/capture_runtime/services/streaming_capture_service.py', import.meta.url), 'utf8'),
    readFile(new URL('../../../tools/acceptance-contract.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(smokeSource, /CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN: '1'/u);
  assert.match(smokeSource, /CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT: acceptance\.artifactRoot/u);
  assert.match(smokeSource, /CAPTURE_OCR_EXECUTION_RUNTIME_SHA256: expectedRuntimeSha256/u);
  assert.match(smokeSource, /sourceRole: 'actual-installed-runtime'/u);
  assert.match(smokeSource, /CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE/u);
  assert.match(smokeSource, /readOcrExecutionProof\(acceptance\.artifactRoot\)/u);
  assert.match(smokeSource, /assertOcrExecutionProofMatchesInstalledJourney\(proof/u);
  assert.match(smokeSource, /modelSha256: proof\.modelSha256/u);
  assert.match(smokeSource, /profileSpecSha256: proof\.profileSpecSha256/u);
  assert.match(smokeSource, /requestedPageScope: proof\.requestedPageScope/u);
  assert.match(smokeSource, /expectedIdentity: \{[\s\S]*semanticArtifactIdentity\.bytes/u);
  assert.match(smokeSource, /ocrExecutionProof: proof/u);
  assert.match(smokeSource, /ocrExecutionProof\.artifactPath/u);
  assert.match(launchPolicy, /#\[cfg\(feature = "acceptance-app-data"\)\][\s\S]*CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN/u);
  assert.doesNotMatch(runtimeConfig, /CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT/u);
  assert.doesNotMatch(ocrWorker, /record_execution_proof|AcceptanceOcrExecutionEvidenceSink/u);
  assert.match(streamingService, /await self\.structure\(capture_id\)[\s\S]*_publish_execution_proof/u);
  assert.match(acceptanceContract, /readOcrExecutionProof[\s\S]*sha256Canonical[\s\S]*Acceptance OCR execution proof evidence is not bound/u);
});

test('acceptance NSIS packaging is feature-gated and output-separated from release NSIS', async () => {
  const [projectText, finalizer, buildSource] = await Promise.all([
    readFile(new URL('../project.json', import.meta.url), 'utf8'),
    readFile(new URL('./finalize-acceptance-nsis.ts', import.meta.url), 'utf8'),
    readFile(new URL('./build-acceptance-nsis.ts', import.meta.url), 'utf8'),
  ]);
  const project = JSON.parse(projectText) as {
    targets?: Record<string, { outputs?: string[]; options?: { commands?: string[]; command?: string } }>;
  };
  const release = project.targets?.['build-nsis'];
  const acceptance = project.targets?.['build-nsis-acceptance'];
  const releaseCommand = JSON.stringify(release);
  const acceptanceCommand = JSON.stringify(acceptance);
  assert.match(releaseCommand, /--bundles nsis/u);
  assert.doesNotMatch(releaseCommand, /acceptance-app-data/u);
  assert.match(acceptanceCommand, /build-acceptance-nsis\.ts/u);
  assert.match(acceptanceCommand, /output\/acceptance-nsis/u);
  assert.doesNotMatch(acceptanceCommand, /src-tauri[\\/]target[\\/].*bundle[\\/]nsis/u);
  assert.notEqual(acceptance, undefined);
  assert.notDeepEqual(acceptance?.outputs, release?.outputs);
  assert.match(finalizer, /finalizeAcceptanceNsis/u);
  assert.match(finalizer, /staged-runtime-sha256/u);
  assert.match(buildSource, /--bundles['\s\S]*nsis/u);
  assert.match(buildSource, /CARGO_TARGET_DIR: cargoTargetDir/u);
  assert.match(buildSource, /assertStagedRuntime\('release'\)/u);
});

test('installed OCR failure acceptance validates and manifests only a real worker failure', async () => {
  const [smokeSource, acceptanceContract] = await Promise.all([
    readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../tools/acceptance-contract.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(smokeSource, /readOcrExecutionFailure\(\s*acceptance\.artifactRoot,[\s\S]*sourceSha256/u);
  assert.match(smokeSource, /ocrExecutionFailure/u);
  assert.match(smokeSource, /ocrExecutionFailure\.artifactPath/u);
  assert.doesNotMatch(smokeSource, /rm\(acceptance\.artifactRoot,\s*\{\s*recursive/u);
  assert.match(acceptanceContract, /readOcrExecutionFailure[\s\S]*stageSequence/u);
});

test('packaged desktop entrypoint renders canonical OCR compute state before source import', async () => {
  const [tauriConfig, appSource, appTemplate, runtimeClient, bundleVerifier] = await Promise.all([
    readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    readFile(new URL('../../../apps/capture-workbench/src/app/app.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../apps/capture-workbench/src/app/app.html', import.meta.url), 'utf8'),
    readFile(new URL('../../../apps/capture-workbench/src/app/services/desktop-runtime-client.service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../tools/verify-capture-workbench-production-bundle.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(tauriConfig, /frontendDist.*dist\/apps\/capture-workbench\/browser/u);
  assert.match(appSource, /CaptureRuntimeComputeStatusComponent/u);
  const computeStatusIndex = appTemplate.indexOf('store.ocrCompute()');
  const sourceImportIndex = appTemplate.indexOf('data-testid="source-import"');
  assert.ok(computeStatusIndex >= 0, 'packaged entrypoint must bind canonical OCR compute state');
  assert.ok(sourceImportIndex > computeStatusIndex, 'OCR compute state must precede source import');
  assert.match(runtimeClient, /invoke<RuntimeReady>\('runtime_ready'/u);
  assert.match(bundleVerifier, /ocr-compute-status/u);
  assert.match(bundleVerifier, /CPU OCR may be slower/u);
});

test('desktop page acquisition reconnects after a CDP attachment has no Tauri page', async () => {
  const page = { url: () => 'http://tauri.localhost/' } as unknown as Page;
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
  assert.equal(connectionCount, 2);
  assert.equal(staleClosed, 1);
});

test('OCR polling reattaches once after target loss and preserves the imported document identity', async () => {
  const documentId = 'document-keep-identity';
  const oldPage = {} as Page;
  const newPage = {} as Page;
  let cardReads = 0;
  const oldCard = {
    getAttribute: async () => {
      cardReads += 1;
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  const newCard = {
    waitFor: async () => undefined,
    count: async () => 1,
    getAttribute: async (name: string) => name === 'data-document-id' ? documentId : 'completed',
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  const result = await waitForDesktopOcrCompletion(
    oldPage,
    oldCard,
    250,
    {
      fileName: 'source.pdf',
      documentId,
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
      exactDocumentCard: (page, fileName) => {
        assert.equal(page, newPage);
        assert.equal(fileName, 'source.pdf');
        return newCard;
      },
    },
  );

  assert.equal(cardReads, 1);
  assert.equal(reattachCount, 1);
  assert.equal(result.page, newPage);
  assert.equal(result.card, newCard);
});

test('OCR polling fails with typed lifecycle evidence when the host dies and never reattaches', async () => {
  const oldCard = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldCard, 250, {
      fileName: 'source.pdf',
      documentId: 'document-keep-identity',
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
      exactDocumentCard: () => oldCard,
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

test('OCR polling rejects a reattached card whose document identity changed', async () => {
  const oldCard = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  const changedCard = {
    waitFor: async () => undefined,
    count: async () => 1,
    getAttribute: async (name: string) => name === 'data-document-id' ? 'different-document' : 'completed',
  } as unknown as ReturnType<Page['locator']>;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldCard, 250, {
      fileName: 'source.pdf',
      documentId: 'document-keep-identity',
      observeLiveness: async () => ({
        appAlive: true,
        runtimeAlive: true,
        cdpOpen: true,
        teardownRequested: false,
        appExitCode: null,
        appSignal: null,
      }),
      reattach: async () => ({ browser: {} as never, page: {} as Page }),
      exactDocumentCard: () => changedCard,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrLifecycleFailure);
      assert.equal(error.kind, 'target-loss');
      return true;
    },
  );
});

test('OCR polling fails closed after a second target loss without a second reattach', async () => {
  const oldCard = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  const reattachedCard = {
    waitFor: async () => undefined,
    count: async () => 1,
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;
  let exactCardReads = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldCard, 250, {
      fileName: 'source.pdf',
      documentId: 'document-keep-identity',
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
      exactDocumentCard: () => {
        exactCardReads += 1;
        return reattachedCard;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopOcrLifecycleFailure);
      assert.equal(error.kind, 'target-loss');
      return true;
    },
  );
  assert.equal(reattachCount, 1);
  assert.equal(exactCardReads, 1);
});

test('OCR polling fails closed with a typed runtime-root-exit when runtime liveness is lost', async () => {
  const oldCard = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldCard, 250, {
      fileName: 'source.pdf',
      documentId: 'document-keep-identity',
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
      exactDocumentCard: () => oldCard,
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
  const oldCard = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldCard, 250, {
      fileName: 'source.pdf',
      documentId: 'document-keep-identity',
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
      exactDocumentCard: () => oldCard,
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
  const oldCard = {
    getAttribute: async () => {
      throw new Error('Target page, context or browser has been closed.');
    },
  } as unknown as ReturnType<Page['locator']>;
  let reattachCount = 0;

  await assert.rejects(
    waitForDesktopOcrCompletion({} as Page, oldCard, 250, {
      fileName: 'source.pdf',
      documentId: 'document-keep-identity',
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
      exactDocumentCard: () => oldCard,
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
  const [source, commandsSource, host] = await Promise.all([
    readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/commands.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /desktop_acceptance_close_window/u);
  assert.match(source, /desktop_acceptance_terminate_root/u);
  assert.doesNotMatch(source, /taskkill(?:\.exe)?/u);
  assert.doesNotMatch(source, /process\.kill/u);
  assert.doesNotMatch(source, /terminateOwnedTree/u);
  assert.match(commandsSource, /pub fn desktop_acceptance_close_window\(window: tauri::Window\)/u);
  assert.match(commandsSource, /GetCurrentProcess/u);
  assert.match(commandsSource, /TerminateProcess/u);
  assert.match(host, /commands::desktop_acceptance_close_window/u);
  assert.match(host, /commands::desktop_acceptance_terminate_root/u);

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

test('OCR screenshot evidence masks whole raw/result cards before capture', async () => {
  const [smokeSource, acceptanceSource, appSource] = await Promise.all([
    readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8'),
    readFile(new URL('./real-desktop-ocr-acceptance.spec.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../apps/capture-workbench/src/app/app.html', import.meta.url), 'utf8'),
  ]);
  assert.match(
    appSource,
    /data-testid="document-raw"[\s\S]*data-testid="document-raw-segments"[\s\S]*data-testid="document-raw-segment"/u,
  );
  const maskHelperStart = smokeSource.indexOf('function acceptanceScreenshotMasks');
  const maskHelper = smokeSource.slice(maskHelperStart, smokeSource.indexOf('\n}', maskHelperStart) + 2);
  assert.match(maskHelper, /getByTestId\('document-raw'\)/u);
  assert.match(maskHelper, /getByTestId\('document-result'\)/u);
  assert.doesNotMatch(maskHelper, /\.review-block pre/u);
  const screenshotStart = smokeSource.indexOf('await page.screenshot({');
  const maskUse = smokeSource.indexOf('mask: acceptanceScreenshotMasks(page)', screenshotStart);
  assert.ok(screenshotStart >= 0 && maskUse > screenshotStart, 'whole-card masks must be passed before screenshot capture.');
  assert.match(acceptanceSource, /getByTestId\('document-raw'\)/u);
  assert.match(acceptanceSource, /getByTestId\('document-result'\)/u);
});

test('Phase 1 OCR checkpoint keeps its masked artifact but defers unapproved pixel diff', async () => {
  const [smokeSource, acceptanceSource] = await Promise.all([
    readFile(new URL('./real-desktop-ocr-smoke.ts', import.meta.url), 'utf8'),
    readFile(new URL('./real-desktop-ocr-acceptance.spec.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(
    smokeSource,
    /acceptanceScreenshot\(page, acceptance, acceptanceScreenshots, '03-ocr-checkpoint'/u,
    'the OCR checkpoint must still produce a privacy-masked artifact',
  );
  assert.match(
    acceptanceSource,
    /name === '01-core-install-started'\s*\|\|\s*name === '02-document-processing'\s*\|\|\s*name === '03-ocr-checkpoint'\) return;/u,
    'the first Phase 1 run must skip pixel diff at the unapproved OCR checkpoint',
  );
  assert.match(
    acceptanceSource,
    /semantic\/proof assertions remain the hard gate[\s\S]*first-run[\s\S]*artifact is retained for manual baseline approval/u,
    'the callback must document why the pixel diff is deferred',
  );
  assert.match(acceptanceSource, /toHaveScreenshot\(/u, 'stable checkpoints must continue using approved goldens');
});

test('real desktop OCR provenance requires the PaddleOCR engine', () => {
  assert.deepEqual(
    parseOcrProvenance([
      'windowsml-ocr · pp-ocrv6-medium-windowsml · windowsml-dml',
    ]),
    {
      engine: 'windowsml-ocr',
      model: 'pp-ocrv6-medium-windowsml',
      device: 'windowsml-dml',
    },
  );
  assert.throws(
    () => parseOcrProvenance(['pdf-embedded · legacy · cpu']),
    /recognized OCR device provenance/u,
  );
});

test('installed OCR acceptance binds worker archive and executable identity to the local candidate mirror', async () => {
  const source = await readFile(
    new URL('./real-desktop-ocr-smoke.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /startLocalCandidateWorkerMirror\(/u);
  assert.match(source, /CAPTURE_RUNTIME_CANDIDATE_ROOT/u);
  assert.match(source, /CAPTURE_RUNTIME_CANDIDATE_ID/u);
  assert.doesNotMatch(source, /capture-engine-ocr-0\.4\.2-windows-x64\.zip/u);
  assert.doesNotMatch(source, /capture-engine-ocr-0\.4\.2-windows-x64-files\.json/u);
  assert.doesNotMatch(source, /packages[\\/]capture-runtime[\\/]dist[\\/]release/u);
  assert.doesNotMatch(source, /readWorkerExecutableSha256FromManifest/u);
});
