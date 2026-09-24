import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptanceScopeContractFor,
  computeAcceptanceArtifactBindingHash,
  runAcceptanceSequence,
  stableAcceptanceArtifactId,
  verifyRecordedCleanupScope,
  type AcceptanceCleanupContext,
  type AcceptanceCleanupProbeHooks,
  type AcceptanceProjectPlan,
} from './three-project-acceptance.ts';

const CLEAN = {
  app: true,
  sidecar: true,
  cdpPort: true,
  temporaryAppData: true,
  ownedPids: true,
  ownedListeners: true,
  ownedWorkers: true,
};

type ScopeRecordsFixture = {
  processRecords: Array<Record<string, unknown>>;
  baselineProcessRecords: Array<Record<string, unknown>>;
  listenerRecords: Array<Record<string, unknown>>;
};

function item(root: string): AcceptanceProjectPlan {
  return {
    project: 'capture-workbench',
    cwd: root,
    target: 'capture-workbench-desktop:acceptance-real',
    artifactRoot: join(root, 'artifacts'),
    scopePath: join(root, 'scope.json'),
    environment: { E2E_ACCEPTANCE_RUN_ID: 'run-cleanup' },
  };
}

async function contextFor(
  options: {
    paths?: {
      modelPaths?: string[];
      appDataPaths?: string[];
      sessionPaths?: string[];
    };
    processRecords?: unknown[];
    listenerRecords?: unknown[];
    probes?: AcceptanceCleanupProbeHooks;
  } = {},
): Promise<AcceptanceCleanupContext> {
  const root = await mkdtemp(join(tmpdir(), 'three-project-cleanup-verifier-'));
  const acceptanceItem = item(root);
  await mkdir(acceptanceItem.artifactRoot, { recursive: true });
  const artifactBytes = Buffer.from('x');
  await writeFile(
    join(acceptanceItem.artifactRoot, 'checkpoint.png'),
    artifactBytes,
  );
  const manifest: Record<string, unknown> = {
    schemaVersion: 2,
    project: acceptanceItem.project,
    runId: 'run-cleanup',
    status: 'completed',
    recordVideo: false,
    artifacts: [
      {
        kind: 'screenshot',
        path: 'checkpoint.png',
        bytes: artifactBytes.length,
        sha256: createHash('sha256').update(artifactBytes).digest('hex'),
      },
    ],
    fixture: { name: 'fixture.pdf', sha256: 'a'.repeat(64) },
    cleanup: { ...CLEAN },
    errors: [],
    consoleErrors: [],
    pageErrors: [],
  };
  const processRecords =
    options.processRecords ??
    ['root', 'app', 'session', 'sidecar', 'model'].map((role, index) => ({
      pid: 10_001 + index,
      creationTimeUtc: '2026-08-26T00:00:00.000Z',
      executable: `C:\\private\\capture-${role}.exe`,
      role,
      runId: 'run-cleanup',
      artifactId: stableAcceptanceArtifactId(
        'capture-workbench',
        'run-cleanup',
      ),
    }));
  const artifactId = stableAcceptanceArtifactId(
    'capture-workbench',
    'run-cleanup',
  );
  const listenerRecords = options.listenerRecords ?? [
    {
      host: '127.0.0.1',
      port: 45_001,
      protocol: 'tcp',
      role: 'cdp',
      runId: 'run-cleanup',
      artifactId,
      owner: processRecords[2],
    },
    {
      host: '127.0.0.1',
      port: 45_002,
      protocol: 'tcp',
      role: 'runtime',
      runId: 'run-cleanup',
      artifactId,
      owner: processRecords[3],
    },
    {
      host: '127.0.0.1',
      port: 45_003,
      protocol: 'tcp',
      role: 'model',
      runId: 'run-cleanup',
      artifactId,
      owner: processRecords[4],
    },
  ];
  const baselineProcessRecords = [
    {
      pid: 20_001,
      creationTimeUtc: '2026-08-26T00:00:00.000Z',
      executable: 'C:\\private\\baseline.exe',
      role: 'baseline',
    },
  ];
  const paths = {
    modelPaths: options.paths?.modelPaths ?? ['C:\\private\\model'],
    appDataPaths: options.paths?.appDataPaths ?? ['C:\\private\\app-data'],
    sessionPaths: options.paths?.sessionPaths ?? ['C:\\private\\session'],
  };
  const artifactSha256 = computeAcceptanceArtifactBindingHash(manifest);
  if (!artifactSha256)
    throw new Error('test fixture artifact hash unavailable');
  await writeFile(
    acceptanceItem.scopePath,
    JSON.stringify({
      schemaVersion: 2,
      project: acceptanceItem.project,
      runId: 'run-cleanup',
      artifactId: stableAcceptanceArtifactId(
        acceptanceItem.project,
        'run-cleanup',
      ),
      artifactSha256,
      expected: acceptanceScopeContractFor(acceptanceItem.project),
      status: 'terminal',
      evidenceComplete: true,
      launchAttempted: true,
      processRecords,
      baselineProcessRecords,
      listenerRecords,
      ...paths,
    }),
    'utf8',
  );
  return {
    item: acceptanceItem,
    manifest,
    scopePath: acceptanceItem.scopePath,
    probes: {
      statPath: async () => {
        throw errno('ENOENT');
      },
      processState: async () => 'absent',
      baselineProcessState: async () => 'present',
      listenerState: async () => 'absent',
      ...options.probes,
    },
  };
}

async function rewriteScope(
  context: AcceptanceCleanupContext,
  changes: Record<string, unknown>,
): Promise<void> {
  const scope = JSON.parse(await readFile(context.scopePath, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(
    context.scopePath,
    `${JSON.stringify({ ...scope, ...changes }, null, 2)}\n`,
    'utf8',
  );
}

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function absentStat(): { isSymbolicLink: () => boolean } {
  return { isSymbolicLink: () => false };
}

test('cleanup verifier treats only ENOENT as absent', async () => {
  const context = await contextFor({
    paths: { modelPaths: ['C:\\private\\missing-model'] },
    probes: {
      statPath: async () => {
        throw errno('ENOENT');
      },
    },
  });

  const proof = await verifyRecordedCleanupScope(context);

  assert.deepEqual(proof.cleanup, CLEAN);
  assert.deepEqual(proof.errors, []);
});

test('valid clean scope requires owned identities and a live baseline', async () => {
  const context = await contextFor();

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, true);
  assert.deepEqual(proof.cleanup, CLEAN);
  assert.deepEqual(proof.errors, []);

  const missingBaseline = await contextFor({
    probes: { baselineProcessState: async () => 'absent' },
  });
  const missingBaselineProof =
    await verifyRecordedCleanupScope(missingBaseline);
  assert.equal(missingBaselineProof.cleanup.ownedWorkers, false);
  assert.deepEqual(missingBaselineProof.errors, [
    'scope_baseline_process_absent',
  ]);
});

test('capture scope may omit an unstarted optional model role without placeholders', async () => {
  const context = await contextFor();
  const scope = JSON.parse(
    await readFile(context.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  scope.processRecords = scope.processRecords.filter(
    (record) => record.role !== 'model',
  );
  scope.listenerRecords = scope.listenerRecords.filter(
    (record) => record.role !== 'model',
  );
  await writeFile(
    context.scopePath,
    `${JSON.stringify(scope)}\n`,
    'utf8',
  );

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, true);
  assert.deepEqual(proof.cleanup, CLEAN);
  assert.deepEqual(proof.errors, []);
});

test('empty required scope sets fail closed even when baseline is present', async () => {
  const context = await contextFor();
  await rewriteScope(context, {
    processRecords: [],
    listenerRecords: [],
    modelPaths: [],
    appDataPaths: [],
    sessionPaths: [],
  });

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, false);
  assert.equal(proof.cleanup.ownedPids, false);
  assert.match(proof.errors.join(' '), /scope_required_process_role_root/u);
});

test('zero PID is rejected before recorded process probing', async () => {
  const context = await contextFor({
    processRecords: ['root', 'app', 'session', 'sidecar', 'model'].map(
      (role, index) => ({
        pid: role === 'app' ? 0 : 10_001 + index,
        creationTimeUtc: '2026-08-26T00:00:00.000Z',
        executable: `C:\\private\\capture-${role}.exe`,
        role,
      }),
    ),
    probes: {
      processState: async () => {
        throw new Error('invalid scope must not probe process state');
      },
    },
  });

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, false);
  assert.equal(proof.cleanup.ownedPids, false);
  assert.deepEqual(proof.errors, ['scope_process_identity_invalid']);
});

test('zero listener port is rejected before recorded listener probing', async () => {
  const context = await contextFor({
    listenerRecords: [
      { host: '127.0.0.1', port: 45_001, role: 'cdp' },
      { host: '127.0.0.1', port: 0, role: 'runtime' },
      { host: '127.0.0.1', port: 45_003, role: 'model' },
    ],
    probes: {
      listenerState: async () => {
        throw new Error('invalid scope must not probe listener state');
      },
    },
  });

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, false);
  assert.equal(proof.cleanup.ownedListeners, false);
  assert.deepEqual(proof.errors, ['scope_listener_identity_invalid']);
});

test('owned process run binding and listener owner identity are mandatory', async () => {
  const processBinding = await contextFor();
  const processScope = JSON.parse(
    await readFile(processBinding.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  processScope.processRecords[1].runId = 'run-other';
  await writeFile(
    processBinding.scopePath,
    `${JSON.stringify(processScope)}\n`,
    'utf8',
  );
  const processProof = await verifyRecordedCleanupScope(processBinding);
  assert.deepEqual(processProof.errors, [
    'scope_process_identity_binding_mismatch',
  ]);

  const listenerOwner = await contextFor();
  const listenerScope = JSON.parse(
    await readFile(listenerOwner.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  listenerScope.listenerRecords[1].owner = {
    ...(listenerScope.listenerRecords[1].owner as Record<string, unknown>),
    pid: 99_999,
  };
  await writeFile(
    listenerOwner.scopePath,
    `${JSON.stringify(listenerScope)}\n`,
    'utf8',
  );
  const listenerProof = await verifyRecordedCleanupScope(listenerOwner);
  assert.deepEqual(listenerProof.errors, ['scope_listener_owner_mismatch']);
});

test('duplicate and baseline-overlapping process identities fail closed', async () => {
  const duplicate = await contextFor();
  const duplicateScope = JSON.parse(
    await readFile(duplicate.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  duplicateScope.processRecords.push({ ...duplicateScope.processRecords[1] });
  await writeFile(
    duplicate.scopePath,
    `${JSON.stringify(duplicateScope)}\n`,
    'utf8',
  );
  const duplicateProof = await verifyRecordedCleanupScope(duplicate);
  assert.ok(duplicateProof.errors.includes('scope_process_identity_duplicate'));

  const overlap = await contextFor();
  const overlapScope = JSON.parse(
    await readFile(overlap.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  overlapScope.baselineProcessRecords[0] = {
    ...overlapScope.processRecords[0],
    role: 'baseline',
  };
  await writeFile(
    overlap.scopePath,
    `${JSON.stringify(overlapScope)}\n`,
    'utf8',
  );
  const overlapProof = await verifyRecordedCleanupScope(overlap);
  assert.ok(overlapProof.errors.includes('scope_baseline_identity_overlap'));
});

test('verifier accepts distinct PyInstaller identities for one role and validates the later listener owner', async () => {
  const context = await contextFor();
  const scope = JSON.parse(
    await readFile(context.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  const sidecar = scope.processRecords.find(
    (record) => record.role === 'sidecar',
  );
  if (!sidecar) throw new Error('sidecar fixture missing');
  const replacement = {
    ...sidecar,
    pid: 10_006,
    creationTimeUtc: '2026-08-26T00:00:02.000Z',
    executable: 'C:\\private\\capture-runtime-child.exe',
  };
  scope.processRecords.push(replacement);
  const runtime = scope.listenerRecords.find(
    (record) => record.role === 'runtime',
  );
  if (!runtime) throw new Error('runtime listener fixture missing');
  runtime.owner = replacement;
  await writeFile(context.scopePath, `${JSON.stringify(scope)}\n`, 'utf8');

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, true);
  assert.deepEqual(proof.cleanup, CLEAN);
  assert.deepEqual(proof.errors, []);
});

test('verifier accepts a same-PID sidecar retry when its exact identity differs', async () => {
  const context = await contextFor();
  const scope = JSON.parse(
    await readFile(context.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  const sidecar = scope.processRecords.find(
    (record) => record.role === 'sidecar',
  );
  if (!sidecar) throw new Error('sidecar fixture missing');
  const replacement = {
    ...sidecar,
    creationTimeUtc: '2026-08-26T00:00:02.000Z',
    executable: 'C:\\private\\capture-runtime-child.exe',
  };
  scope.processRecords.push(replacement);
  const runtime = scope.listenerRecords.find(
    (record) => record.role === 'runtime',
  );
  if (!runtime) throw new Error('runtime listener fixture missing');
  runtime.owner = replacement;
  await writeFile(context.scopePath, `${JSON.stringify(scope)}\n`, 'utf8');

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, true);
  assert.deepEqual(proof.cleanup, CLEAN);
  assert.deepEqual(proof.errors, []);
});

test('baseline PID reuse is rejected by exact baseline identity survival even when owned identity is distinct', async () => {
  const context = await contextFor();
  const scope = JSON.parse(
    await readFile(context.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  const sidecar = scope.processRecords.find(
    (record) => record.role === 'sidecar',
  );
  const baseline = scope.baselineProcessRecords[0];
  if (!sidecar || !baseline) throw new Error('scope identity fixture missing');
  const reusedBaseline = {
    ...baseline,
    pid: sidecar.pid,
    creationTimeUtc: '2026-08-26T00:00:01.000Z',
    executable: 'C:\\private\\baseline-before-reuse.exe',
  };
  scope.baselineProcessRecords[0] = reusedBaseline;
  await writeFile(context.scopePath, `${JSON.stringify(scope)}\n`, 'utf8');

  const proof = await verifyRecordedCleanupScope({
    ...context,
    probes: {
      ...context.probes,
      processState: async (record) => {
        if (record.pid === sidecar.pid) {
          assert.equal(record.pid, sidecar.pid);
          assert.equal(record.creationTimeUtc, sidecar.creationTimeUtc);
          assert.equal(record.executable, sidecar.executable);
        }
        return 'absent';
      },
      baselineProcessState: async (record) => {
        assert.equal(record.pid, reusedBaseline.pid);
        assert.equal(record.creationTimeUtc, reusedBaseline.creationTimeUtc);
        assert.equal(record.executable, reusedBaseline.executable);
        return 'absent';
      },
    },
  });

  assert.equal(proof.scopeVerified, true);
  assert.equal(proof.cleanup.ownedWorkers, false);
  assert.ok(proof.errors.includes('scope_baseline_process_absent'));
});

test('verifier rejects exact duplicate process identity but permits a different identity in the same role', async () => {
  const context = await contextFor();
  const scope = JSON.parse(
    await readFile(context.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  const sidecar = scope.processRecords.find(
    (record) => record.role === 'sidecar',
  );
  if (!sidecar) throw new Error('sidecar fixture missing');
  scope.processRecords.push({ ...sidecar });
  await writeFile(context.scopePath, `${JSON.stringify(scope)}\n`, 'utf8');

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, false);
  assert.ok(proof.errors.includes('scope_process_identity_duplicate'));
  assert.ok(!proof.errors.includes('scope_duplicate_process_role_sidecar'));
});

test('verifier rejects an exact duplicate listener record while allowing listener retry history', async () => {
  const context = await contextFor();
  const scope = JSON.parse(
    await readFile(context.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  const runtime = scope.listenerRecords.find(
    (record) => record.role === 'runtime',
  );
  if (!runtime) throw new Error('runtime listener fixture missing');
  scope.listenerRecords.push({ ...runtime });
  await writeFile(context.scopePath, `${JSON.stringify(scope)}\n`, 'utf8');

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, false);
  assert.ok(proof.errors.includes('scope_listener_identity_duplicate'));
  assert.ok(!proof.errors.includes('scope_duplicate_listener_role_runtime'));
});

test('verifier rejects a listener owner whose process role does not authorize that listener role', async () => {
  const context = await contextFor();
  const scope = JSON.parse(
    await readFile(context.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  const runtime = scope.listenerRecords.find(
    (record) => record.role === 'runtime',
  );
  if (!runtime) throw new Error('runtime listener fixture missing');
  runtime.owner = scope.processRecords.find((record) => record.role === 'app');
  await writeFile(context.scopePath, `${JSON.stringify(scope)}\n`, 'utf8');

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, false);
  assert.ok(proof.errors.includes('scope_listener_owner_role_mismatch'));
});

test('cleanup fails closed when one historical owned identity survives, and passes when all are absent', async () => {
  const context = await contextFor();
  const scope = JSON.parse(
    await readFile(context.scopePath, 'utf8'),
  ) as ScopeRecordsFixture;
  const sidecar = scope.processRecords.find(
    (record) => record.role === 'sidecar',
  );
  if (!sidecar) throw new Error('sidecar fixture missing');
  const replacement = {
    ...sidecar,
    creationTimeUtc: '2026-08-26T00:00:02.000Z',
    executable: 'C:\\private\\capture-runtime-child.exe',
  };
  scope.processRecords.push(replacement);
  await writeFile(context.scopePath, `${JSON.stringify(scope)}\n`, 'utf8');
  const survivor = await verifyRecordedCleanupScope({
    ...context,
    probes: {
      ...context.probes,
      processState: async (record) =>
        record.pid === sidecar.pid &&
        record.creationTimeUtc === replacement.creationTimeUtc &&
        record.executable === replacement.executable
          ? 'present'
          : 'absent',
    },
  });
  assert.equal(survivor.cleanup.ownedPids, false);
  assert.ok(
    survivor.errors.includes('Recorded owned process residue remained.'),
  );

  const allGone = await verifyRecordedCleanupScope(context);
  assert.equal(allGone.cleanup.ownedPids, true);
  assert.equal(allGone.cleanup.ownedListeners, true);
});

test('replayed scope identity and wrong artifact hash fail closed', async () => {
  const replayed = await contextFor();
  await rewriteScope(replayed, { runId: 'run-other' });
  const replayedProof = await verifyRecordedCleanupScope(replayed);
  assert.equal(replayedProof.scopeVerified, false);
  assert.deepEqual(replayedProof.errors, ['scope_artifact_identity_mismatch']);

  const wrongArtifact = await contextFor();
  const wrongManifest = {
    ...wrongArtifact.manifest,
    artifacts: [
      {
        kind: 'screenshot',
        path: 'different.png',
        bytes: 1,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  const wrongArtifactProof = await verifyRecordedCleanupScope({
    ...wrongArtifact,
    manifest: wrongManifest,
  });
  assert.equal(wrongArtifactProof.scopeVerified, false);
  assert.deepEqual(wrongArtifactProof.errors, ['scope_artifact_hash_mismatch']);
});

test('baseline-only scope cannot substitute for owned app/session descendants', async () => {
  const context = await contextFor();
  await rewriteScope(context, { processRecords: [] });

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.scopeVerified, false);
  assert.match(proof.errors.join(' '), /scope_required_process_role_root/u);
});

test('self-reported clean flags cannot bypass live owned residue', async () => {
  const context = await contextFor();
  const started: string[] = [];
  const results = await runAcceptanceSequence(
    [context.item],
    'run-cleanup',
    false,
    {
      prepareScope: async () => undefined,
      spawnChild: async () => {
        started.push(context.item.project);
        return 0;
      },
      readManifest: async () => context.manifest,
      verifyCleanup: async (cleanupContext) =>
        verifyRecordedCleanupScope({
          ...cleanupContext,
          probes: {
            statPath: async () => {
              throw errno('ENOENT');
            },
            processState: async (record) =>
              record === undefined
                ? 'unknown'
                : record.pid === 10_005
                  ? 'present'
                  : 'absent',
            baselineProcessState: async () => 'present',
            listenerState: async () => 'absent',
          },
        }),
    },
  );

  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results.length, 1);
  assert.equal(results[0].cleanupVerified, false);
  assert.equal(results[0].errorCode, 'cleanup_flags_mismatch');
});

test('permission and I/O stat failures fail closed with stable path-free codes', async () => {
  const permissionPath = 'C:\\private\\permission-model';
  const ioPath = 'C:\\private\\io-session';
  const context = await contextFor({
    paths: { modelPaths: [permissionPath], sessionPaths: [ioPath] },
    probes: {
      statPath: async (path) => {
        if (path === permissionPath) throw errno('EACCES');
        if (path === ioPath) throw errno('EIO');
        throw errno('ENOENT');
      },
    },
  });

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.cleanup.temporaryAppData, false);
  assert.equal(proof.cleanup.ownedWorkers, false);
  assert.deepEqual(proof.errors, [
    'cleanup_probe_temporary_app_data_permission_denied',
    'cleanup_probe_temporary_app_data_io_error',
  ]);
  assert.doesNotMatch(
    JSON.stringify(proof),
    /C:\\private|permission-model|io-session/u,
  );
});

test('symlink/reparse-like path is residue even when its target is unavailable', async () => {
  const context = await contextFor({
    paths: { modelPaths: ['C:\\private\\junction'] },
    probes: {
      statPath: async () => ({ isSymbolicLink: () => true }),
    },
  });

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.cleanup.temporaryAppData, false);
  assert.equal(proof.cleanup.ownedWorkers, false);
  assert.deepEqual(proof.errors, [
    'Recorded model or app-data residue remained.',
  ]);
});

test('path reappearing or disappearing during the two-probe check is not clean', async () => {
  const reappears = 'C:\\private\\reappears';
  const disappears = 'C:\\private\\disappears';
  const calls = new Map<string, number>();
  const context = await contextFor({
    paths: { modelPaths: [reappears], sessionPaths: [disappears] },
    probes: {
      statPath: async (path) => {
        const count = (calls.get(path) ?? 0) + 1;
        calls.set(path, count);
        if (path === reappears && count === 1) throw errno('ENOENT');
        if (path === reappears) return absentStat();
        if (path === disappears && count === 1) return absentStat();
        if (path === disappears && count === 2) throw errno('ENOENT');
        throw errno('ENOENT');
      },
    },
  });

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.cleanup.temporaryAppData, false);
  assert.equal(proof.cleanup.ownedWorkers, false);
  assert.deepEqual(proof.errors, [
    'cleanup_probe_temporary_app_data_race_detected',
    'cleanup_probe_temporary_app_data_race_detected',
  ]);
  assert.equal(calls.get(reappears), 2);
  assert.equal(calls.get(disappears), 2);
});

test('unknown process and listener probes fail their ownership flags without paths', async () => {
  const probes: AcceptanceCleanupProbeHooks = {
    statPath: async () => {
      throw errno('ENOENT');
    },
    processState: async () => 'unknown',
    listenerState: async () => 'unknown',
  };
  const context = await contextFor({
    probes,
  });

  const proof = await verifyRecordedCleanupScope(context);

  assert.equal(proof.cleanup.app, false);
  assert.equal(proof.cleanup.ownedPids, false);
  assert.equal(proof.cleanup.cdpPort, false);
  assert.equal(proof.cleanup.ownedListeners, false);
  assert.deepEqual(proof.errors, [
    'cleanup_probe_owned_process_unavailable',
    'cleanup_probe_owned_listener_unavailable',
  ]);
  assert.doesNotMatch(JSON.stringify(proof), /C:\\private|capture\.exe/u);
});

test('sequence promotes cleanup probe code to aggregate errorCode and stops before the next project', async () => {
  const firstContext = await contextFor();
  const first = firstContext.item;
  const second = { ...first, project: 'cert-prep' as const };
  const manifest = {
    ...firstContext.manifest,
    status: 'failed',
    cleanup: { ...CLEAN, temporaryAppData: false },
  };
  const started: string[] = [];
  const results = await runAcceptanceSequence(
    [first, second],
    'run-cleanup',
    false,
    {
      prepareScope: async () => undefined,
      spawnChild: async (project) => {
        started.push(project.project);
        return 0;
      },
      readManifest: async () => manifest,
      verifyCleanup: async () => ({
        cleanup: { ...CLEAN, temporaryAppData: false },
        errors: ['cleanup_probe_temporary_app_data_permission_denied'],
        scopeVerified: true,
      }),
    },
  );

  assert.deepEqual(started, ['capture-workbench']);
  assert.equal(results.length, 1);
  assert.equal(results[0].cleanupVerified, false);
  assert.equal(
    results[0].errorCode,
    'cleanup_probe_temporary_app_data_permission_denied',
  );
  assert.deepEqual(results[0].cleanupErrors, [
    'cleanup_probe_temporary_app_data_permission_denied',
  ]);
  assert.doesNotMatch(
    JSON.stringify(results),
    /C:\\private|acceptance-manifest\.json/u,
  );
});
