import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rename as renameFs,
  unlink as unlinkFs,
  writeFile,
} from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance scope tests cross the workspace-level evidence seam.
import {
  acceptanceScopeContractFor,
  stableAcceptanceArtifactId,
} from '../../../tools/three-project-acceptance.ts';
import {
  AcceptanceScopeStorageError,
  CaptureAcceptanceScopeOwner,
  patchCaptureAcceptanceScopePaths,
  type AcceptanceScopeSnapshot,
} from './acceptance-scope.ts';

const runId = 'run-scope-owner';
const artifactId = stableAcceptanceArtifactId('capture-workbench', runId);

function identity(
  pid: number,
  executable: string,
  name: string,
  parentPid?: number,
) {
  return {
    pid,
    parentPid,
    creationTimeUtc: '2026-08-26T00:00:00.000Z',
    executable,
    name,
  };
}

function preparedScope() {
  return {
    schemaVersion: 2,
    project: 'capture-workbench',
    runId,
    artifactId,
    artifactSha256: null,
    expected: acceptanceScopeContractFor('capture-workbench'),
    status: 'prepared',
    evidenceComplete: false,
    launchAttempted: false,
    processRecords: [],
    baselineProcessRecords: [],
    listenerRecords: [],
    modelPaths: [],
    appDataPaths: [],
    sessionPaths: [],
  };
}

function snapshot(
  options: {
    readonly listeners?: boolean;
    readonly app?: boolean;
    readonly model?: boolean;
  } = {},
): AcceptanceScopeSnapshot {
  const processes = [
    identity(100, 'C:\\Windows\\System32\\node.exe', 'node.exe'),
    identity(150, 'C:\\Windows\\System32\\node.exe', 'node.exe', 100),
    ...(options.app === false
      ? []
      : [
          identity(
            200,
            'C:\\Program Files\\Capture\\capture-workbench-desktop.exe',
            'capture-workbench-desktop.exe',
            150,
          ),
          identity(
            300,
            'C:\\Program Files\\Microsoft\\EdgeWebView\\msedgewebview2.exe',
            'msedgewebview2.exe',
            200,
          ),
          identity(
            400,
            'C:\\Program Files\\Capture\\capture-runtime.exe',
            'capture-runtime.exe',
            200,
          ),
          ...(options.model
            ? [
                identity(
                  600,
                  'C:\\Program Files\\Ollama\\ollama.exe',
                  'ollama.exe',
                  400,
                ),
              ]
            : []),
        ]),
    identity(500, 'C:\\Program Files\\Ollama\\ollama.exe', 'ollama.exe', 1),
  ];
  return {
    processes,
    listeners:
      options.listeners === false
        ? []
        : [
            {
              host: '127.0.0.1',
              port: 45_001,
              protocol: 'tcp',
              owningPid: 300,
            },
            {
              host: '127.0.0.1',
              port: 45_002,
              protocol: 'tcp',
              owningPid: 400,
            },
            ...(options.model
              ? [
                  {
                    host: '127.0.0.1',
                    port: 45_003,
                    protocol: 'tcp' as const,
                    owningPid: 600,
                  },
                ]
              : []),
          ],
  };
}

function pyInstallerSidecarSnapshot(
  sidecarPid: number,
  creationTimeUtc: string,
  listenerOwnerPid?: number,
): AcceptanceScopeSnapshot {
  const base = snapshot({ listeners: false });
  return {
    processes: base.processes.map((process_) =>
      process_.pid === 400
        ? {
            ...process_,
            pid: sidecarPid,
            creationTimeUtc,
          }
        : process_,
    ),
    listeners:
      listenerOwnerPid === undefined
        ? []
        : [
            {
              host: '127.0.0.1',
              port: 45_002,
              protocol: 'tcp',
              owningPid: listenerOwnerPid,
            },
          ],
  };
}

async function createFixture(): Promise<{
  readonly root: string;
  readonly scopePath: string;
  readonly manifestPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'capture-acceptance-scope-'));
  const scopePath = join(root, 'scope.json');
  const manifestPath = join(root, 'acceptance-manifest.json');
  await writeFile(scopePath, `${JSON.stringify(preparedScope())}\n`, 'utf8');
  await writeFile(
    manifestPath,
    JSON.stringify({
      artifacts: [
        {
          kind: 'report',
          path: 'report.json',
          bytes: 1,
          sha256: 'a'.repeat(64),
        },
      ],
    }),
    'utf8',
  );
  return { root, scopePath, manifestPath };
}

function ownerFor(
  scopePath: string,
  snapshots: readonly AcceptanceScopeSnapshot[],
  overrides: ConstructorParameters<typeof CaptureAcceptanceScopeOwner>[0] = {},
): CaptureAcceptanceScopeOwner {
  let index = 0;
  return new CaptureAcceptanceScopeOwner({
    scopePath,
    runId,
    rootPid: 100,
    paths: {
      modelPaths: ['C:\\run\\model-staging'],
      appDataPaths: ['C:\\run\\app-data'],
      sessionPaths: ['C:\\run\\session'],
    },
    probe: {
      snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)],
    },
    ...overrides,
  });
}

test('prepared binding mismatch is rejected before scope ownership starts', async () => {
  const fixture = await createFixture();
  const value = preparedScope();
  value.runId = 'replayed-run';
  await writeFile(fixture.scopePath, `${JSON.stringify(value)}\n`, 'utf8');
  const owner = ownerFor(fixture.scopePath, [snapshot()]);

  await assert.rejects(
    owner.prepare(),
    /capture_acceptance_scope_prepared_binding_invalid/u,
  );
});

test('scope writes are atomic and preserve the prepared file on rename failure', async () => {
  const fixture = await createFixture();
  const original = await readFile(fixture.scopePath, 'utf8');
  const owner = ownerFor(fixture.scopePath, [snapshot()], {
    files: {
      rename: async () => {
        throw new Error('injected rename failure');
      },
    },
  });

  await assert.rejects(
    owner.prepare(),
    (error: unknown) =>
      error instanceof AcceptanceScopeStorageError &&
      error.code === 'capture_acceptance_scope_storage_rename_failed' &&
      error.cause instanceof Error &&
      error.cause.message === 'injected rename failure',
  );
  assert.equal(await readFile(fixture.scopePath, 'utf8'), original);
});

test('owner records baseline separately and omits an unstarted optional model', async () => {
  const fixture = await createFixture();
  const owner = ownerFor(fixture.scopePath, [
    snapshot(),
    snapshot(),
    snapshot({ app: false }),
  ]);
  await owner.prepare();
  await owner.recordLaunch(150);
  await owner.finalizeFromManifest(fixture.manifestPath);

  const scope = JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
    status: string;
    evidenceComplete: boolean;
    processRecords: Array<{ role: string; pid: number }>;
    baselineProcessRecords: Array<{ role: string; pid: number }>;
    listenerRecords: Array<{ role: string; owningPid?: number; port: number }>;
  };
  assert.equal(scope.status, 'terminal');
  assert.equal(scope.evidenceComplete, true);
  assert.deepEqual(
    scope.baselineProcessRecords.map((record) => record.pid),
    [500],
  );
  assert.deepEqual(
    scope.processRecords.map((record) => record.role),
    ['root', 'app', 'session', 'sidecar'],
  );
  assert.deepEqual(
    scope.listenerRecords.map((record) => record.role),
    ['cdp', 'runtime'],
  );
});

test('owner records the optional model only after observing its descendant identity', async () => {
  const fixture = await createFixture();
  const owner = ownerFor(fixture.scopePath, [
    snapshot(),
    snapshot({ model: true }),
    snapshot({ app: false }),
  ]);
  await owner.prepare();
  await owner.recordLaunch(150);
  await owner.finalizeFromManifest(fixture.manifestPath);

  const scope = JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
    processRecords: Array<{ role: string; pid: number }>;
    listenerRecords: Array<{ role: string; port: number }>;
  };
  assert.equal(
    scope.processRecords.find((record) => record.role === 'model')?.pid,
    600,
  );
  assert.equal(
    scope.listenerRecords.find((record) => record.role === 'model')?.port,
    45_003,
  );
});

test('owner retains PyInstaller sidecar bootloader and child identities and binds a later runtime listener to the child', async () => {
  const fixture = await createFixture();
  const owner = ownerFor(fixture.scopePath, [
    pyInstallerSidecarSnapshot(400, '2026-08-26T00:00:01.000Z'),
    pyInstallerSidecarSnapshot(400, '2026-08-26T00:00:01.000Z'),
    pyInstallerSidecarSnapshot(401, '2026-08-26T00:00:02.000Z', 401),
    pyInstallerSidecarSnapshot(401, '2026-08-26T00:00:02.000Z', 401),
  ]);
  await owner.prepare();
  await owner.recordLaunch(150);
  await owner.finalizeFromManifest(fixture.manifestPath);

  const scope = JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
    processRecords: Array<{
      role: string;
      pid: number;
      creationTimeUtc: string;
      executable: string;
    }>;
    listenerRecords: Array<{
      role: string;
      owningPid?: number;
      owner: { pid: number; creationTimeUtc: string; executable: string };
    }>;
  };
  assert.deepEqual(
    scope.processRecords
      .filter((record) => record.role === 'sidecar')
      .map((record) => [record.pid, record.creationTimeUtc, record.executable]),
    [
      [
        400,
        '2026-08-26T00:00:01.000Z',
        'C:\\Program Files\\Capture\\capture-runtime.exe',
      ],
      [
        401,
        '2026-08-26T00:00:02.000Z',
        'C:\\Program Files\\Capture\\capture-runtime.exe',
      ],
    ],
  );
  assert.deepEqual(
    scope.listenerRecords
      .filter((record) => record.role === 'runtime')
      .map((record) => [record.owner.pid, record.owner.creationTimeUtc]),
    [[401, '2026-08-26T00:00:02.000Z']],
  );
});

test('listener disappearance after close remains readable for cleanup proof', async () => {
  const fixture = await createFixture();
  const owner = ownerFor(fixture.scopePath, [
    snapshot(),
    snapshot(),
    snapshot({ listeners: false }),
  ]);
  await owner.prepare();
  await owner.recordLaunch(150);
  await owner.finalizeFromManifest(fixture.manifestPath);

  const scope = JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
    status: string;
    evidenceComplete: boolean;
    listenerRecords: Array<{ role: string }>;
  };
  assert.equal(scope.status, 'terminal');
  assert.equal(scope.evidenceComplete, true);
  assert.deepEqual(
    scope.listenerRecords.map((record) => record.role),
    ['cdp', 'runtime'],
  );
});

test('probe failure during finalization is terminal but explicitly incomplete', async () => {
  const fixture = await createFixture();
  let calls = 0;
  const owner = ownerFor(fixture.scopePath, [snapshot()], {
    probe: {
      snapshot: async () => {
        calls += 1;
        if (calls >= 3) throw new Error('injected probe failure');
        return snapshot();
      },
    },
  });
  await owner.prepare();
  await owner.recordLaunch(150);
  await owner.finalizeFromManifest(fixture.manifestPath);
  const scope = JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
    status: string;
    evidenceComplete: boolean;
  };
  assert.equal(scope.status, 'terminal');
  assert.equal(scope.evidenceComplete, false);
});

test('owner refresh and path patch serialize one scope mutation without a lost update', async () => {
  // Design invariant: every scope read-modify-write, including owner refresh and
  // the external path patch, is one exclusive lease transaction. A rename retry
  // without this invariant would permit the last writer to erase the other
  // writer's evidence. The adapter below is a deterministic two-process seam:
  // it releases both pre-transaction reads, then makes the unprotected writer
  // lose its path update. A correct storage module serializes before this race.
  const fixture = await createFixture();
  const initialPaths = {
    modelPaths: ['C:\\run\\model-staging'],
    appDataPaths: ['C:\\run\\app-data'],
    sessionPaths: ['C:\\run\\session'],
  };
  const patchedPaths = {
    modelPaths: ['C:\\patched\\model-staging'],
    appDataPaths: ['C:\\patched\\app-data'],
    sessionPaths: ['C:\\patched\\session'],
  };
  let raceEnabled = false;
  let raceReads = 0;
  let releaseRace!: () => void;
  const raceReleased = new Promise<void>((resolveRace) => {
    releaseRace = resolveRace;
  });
  let patchRenamed = false;
  let releaseOwnerRename!: () => void;
  const ownerRenameReleased = new Promise<void>((resolveOwner) => {
    releaseOwnerRename = resolveOwner;
  });
  const files = {
    readFile: async (path: string): Promise<string> => {
      const value = await readFile(path, 'utf8');
      const lockExists = await readdir(fixture.root).then((entries) =>
        entries.some((entry) => entry === 'scope.json.lock'),
      );
      if (
        raceEnabled &&
        !lockExists &&
        path === fixture.scopePath &&
        raceReads < 2
      ) {
        raceReads += 1;
        if (raceReads === 2) releaseRace();
        await raceReleased;
      }
      return value;
    },
    writeFile: async (path: string, contents: string): Promise<void> => {
      await writeFile(path, contents, 'utf8');
    },
    rename: async (from: string, to: string): Promise<void> => {
      const value = JSON.parse(await readFile(from, 'utf8')) as {
        readonly modelPaths?: readonly string[];
      };
      const isPatch = value.modelPaths?.[0] === patchedPaths.modelPaths[0];
      // With the fixed module a lease exists during the rename, so the
      // deterministic unprotected-writer ordering is intentionally bypassed.
      const lockExists = await readdir(fixture.root).then((entries) =>
        entries.some((entry) => entry === 'scope.json.lock'),
      );
      if (raceEnabled && !isPatch && !lockExists && !patchRenamed) {
        await ownerRenameReleased;
      }
      await renameFs(from, to);
      if (isPatch) {
        patchRenamed = true;
        releaseOwnerRename();
      }
    },
    writeFileExclusive: async (
      path: string,
      contents: string,
    ): Promise<void> => {
      await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
    },
  } as unknown as ConstructorParameters<
    typeof CaptureAcceptanceScopeOwner
  >[0]['files'];
  const prepared = preparedScope();
  prepared.modelPaths = initialPaths.modelPaths;
  prepared.appDataPaths = initialPaths.appDataPaths;
  prepared.sessionPaths = initialPaths.sessionPaths;
  await writeFile(fixture.scopePath, `${JSON.stringify(prepared)}\n`, 'utf8');
  const owner = ownerFor(
    fixture.scopePath,
    [snapshot(), snapshot(), snapshot()],
    { files: { ...files } },
  );
  await owner.prepare();
  await owner.recordLaunch(150);
  raceEnabled = true;

  await Promise.all([
    owner.refresh(),
    patchCaptureAcceptanceScopePaths(
      fixture.scopePath,
      runId,
      patchedPaths,
      files,
    ),
  ]);

  const scope = JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
    readonly modelPaths: readonly string[];
    readonly appDataPaths: readonly string[];
    readonly sessionPaths: readonly string[];
    readonly processRecords: readonly { readonly role: string }[];
  };
  assert.deepEqual(scope.modelPaths, patchedPaths.modelPaths);
  assert.deepEqual(scope.appDataPaths, patchedPaths.appDataPaths);
  assert.deepEqual(scope.sessionPaths, patchedPaths.sessionPaths);
  assert.ok(scope.processRecords.some((record) => record.role === 'root'));
  assert.deepEqual(
    (await readdir(fixture.root)).filter((entry) =>
      entry.startsWith('scope.json.'),
    ),
    [],
  );
});

test('a dead stale scope lease is reconciled before applying a path patch', async () => {
  const fixture = await createFixture();
  await writeFile(
    `${fixture.scopePath}.lock`,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 987_654,
      createdAtEpochMs: Date.now() - 60_000,
      token: 'stale-test-lock',
    })}\n`,
    'utf8',
  );
  const paths = {
    modelPaths: ['C:\\reconciled\\model'],
    appDataPaths: ['C:\\reconciled\\app-data'],
    sessionPaths: ['C:\\reconciled\\session'],
  };

  await patchCaptureAcceptanceScopePaths(fixture.scopePath, runId, paths, {
    processAlive: async () => 'dead',
  });

  const scope = JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
    readonly modelPaths: readonly string[];
  };
  assert.deepEqual(scope.modelPaths, paths.modelPaths);
  await assert.rejects(
    readFile(`${fixture.scopePath}.lock`, 'utf8'),
    (error: unknown) => isNotFoundError(error),
  );
});

test('malformed scope is a typed parse failure and releases its lease', async () => {
  const fixture = await createFixture();
  await writeFile(fixture.scopePath, '{ malformed', 'utf8');

  await assert.rejects(
    patchCaptureAcceptanceScopePaths(fixture.scopePath, runId, {
      modelPaths: ['C:\\parse\\model'],
      appDataPaths: ['C:\\parse\\app-data'],
      sessionPaths: ['C:\\parse\\session'],
    }),
    (error: unknown) =>
      error instanceof AcceptanceScopeStorageError &&
      error.code === 'capture_acceptance_scope_storage_parse_failed',
  );
  await assert.rejects(
    readFile(`${fixture.scopePath}.lock`, 'utf8'),
    (error: unknown) => isNotFoundError(error),
  );
});

test('a live scope lease fails closed within the bounded injected wait', async () => {
  const fixture = await createFixture();
  const clock = 1_000_000;
  await writeFile(
    `${fixture.scopePath}.lock`,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 123_456,
      createdAtEpochMs: clock,
      token: 'live-test-lock',
    })}\n`,
    'utf8',
  );
  let now = clock;

  await assert.rejects(
    patchCaptureAcceptanceScopePaths(
      fixture.scopePath,
      runId,
      {
        modelPaths: ['C:\\busy\\model'],
        appDataPaths: ['C:\\busy\\app-data'],
        sessionPaths: ['C:\\busy\\session'],
      },
      {
        now: () => (now += 1_000),
        delay: async () => undefined,
        processAlive: async () => 'alive',
      },
    ),
    (error: unknown) =>
      error instanceof AcceptanceScopeStorageError &&
      error.code === 'capture_acceptance_scope_storage_lock_busy',
  );
  assert.equal(
    await readFile(`${fixture.scopePath}.lock`, 'utf8'),
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 123_456,
      createdAtEpochMs: clock,
      token: 'live-test-lock',
    })}\n`,
  );
});

test('a write failure is typed and removes both temporary and lease files', async () => {
  const fixture = await createFixture();
  let temporaryPath = '';
  const owner = ownerFor(fixture.scopePath, [snapshot()], {
    files: {
      writeFile: async (path, contents) => {
        temporaryPath = path;
        await writeFile(path, contents, 'utf8');
        throw new Error('injected write failure');
      },
    },
  });

  await assert.rejects(
    owner.prepare(),
    (error: unknown) =>
      error instanceof AcceptanceScopeStorageError &&
      error.code === 'capture_acceptance_scope_storage_write_failed' &&
      error.cause instanceof Error &&
      error.cause.message === 'injected write failure',
  );
  assert.notEqual(temporaryPath, '');
  await assert.rejects(readFile(temporaryPath, 'utf8'), isNotFoundError);
  assert.deepEqual(
    (await readdir(fixture.root)).filter((entry) =>
      entry.startsWith('scope.json.'),
    ),
    [],
  );
});

test('a stale reconciler cannot move a replacement lease observed after another claim', async () => {
  const fixture = await createFixture();
  const lockPath = `${fixture.scopePath}.lock`;
  const staleLease = {
    schemaVersion: 1,
    pid: 987_654,
    createdAtEpochMs: Date.now() - 60_000,
    token: 'stale-lease-A',
  };
  const replacementLease = {
    schemaVersion: 1,
    pid: 123_456,
    createdAtEpochMs: Date.now(),
    token: 'replacement-lease-B',
  };
  await writeFile(lockPath, `${JSON.stringify(staleLease)}\n`, 'utf8');
  let staleReads = 0;
  let releaseStaleReads!: () => void;
  const staleReadsReleased = new Promise<void>((resolveReads) => {
    releaseStaleReads = resolveReads;
  });
  let replacementMoved = false;
  let staleRenameCalls = 0;
  let firstStaleClaimed!: () => void;
  const firstStaleClaimedPromise = new Promise<void>((resolveClaim) => {
    firstStaleClaimed = resolveClaim;
  });
  let now = Date.now();
  const files = {
    readFile: async (path: string): Promise<string> => {
      const value = await readFile(path, 'utf8');
      const reconcileGateExists = await readdir(fixture.root).then((entries) =>
        entries.some((entry) => entry === 'scope.json.lock.reconcile'),
      );
      // This is the old implementation's interleaving. A corrected module
      // owns the reconcile gate before observing a lease, so the two reads
      // cannot both enter this branch.
      if (path === lockPath && !reconcileGateExists && staleReads < 2) {
        staleReads += 1;
        if (staleReads === 2) releaseStaleReads();
        await staleReadsReleased;
      }
      return value;
    },
    writeFileExclusive: async (
      path: string,
      contents: string,
    ): Promise<void> => {
      await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
    },
    rename: async (from: string, to: string): Promise<void> => {
      if (from === lockPath && to.endsWith('.stale')) {
        staleRenameCalls += 1;
        if (staleRenameCalls > 1) await firstStaleClaimedPromise;
        const source = JSON.parse(await readFile(from, 'utf8')) as {
          readonly token?: string;
        };
        if (source.token === replacementLease.token) replacementMoved = true;
        await renameFs(from, to);
        if (source.token === staleLease.token) {
          await writeFile(lockPath, `${JSON.stringify(replacementLease)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
          });
          firstStaleClaimed();
        }
        return;
      }
      await renameFs(from, to);
    },
    delay: async () => undefined,
    now: () => (now += 1_000),
    processAlive: async (pid: number) =>
      pid === staleLease.pid ? 'dead' : 'alive',
  } as unknown as ConstructorParameters<
    typeof CaptureAcceptanceScopeOwner
  >[0]['files'];

  const patchPaths = {
    modelPaths: ['C:\\aba\\model'],
    appDataPaths: ['C:\\aba\\app-data'],
    sessionPaths: ['C:\\aba\\session'],
  };
  const attempts = [
    patchCaptureAcceptanceScopePaths(
      fixture.scopePath,
      runId,
      patchPaths,
      files,
    ),
    patchCaptureAcceptanceScopePaths(
      fixture.scopePath,
      runId,
      patchPaths,
      files,
    ),
  ];
  await Promise.allSettled(attempts);
  assert.equal(replacementMoved, false);
  assert.equal(
    await readFile(lockPath, 'utf8'),
    `${JSON.stringify(replacementLease)}\n`,
  );
});

test('an outstanding refresh cannot regress a terminal scope after finalization', async () => {
  const fixture = await createFixture();
  const delayWaiters: Array<() => void> = [];
  let firstDelayStarted!: () => void;
  const firstDelayStartedPromise = new Promise<void>((resolveDelay) => {
    firstDelayStarted = resolveDelay;
  });
  let secondDelayStarted!: () => void;
  const secondDelayStartedPromise = new Promise<void>((resolveDelay) => {
    secondDelayStarted = resolveDelay;
  });
  const owner = ownerFor(
    fixture.scopePath,
    [snapshot(), snapshot(), snapshot(), snapshot()],
    {
      files: {
        delay: async () => {
          await new Promise<void>((resolveDelay) => {
            delayWaiters.push(resolveDelay);
            if (delayWaiters.length === 1) firstDelayStarted();
            if (delayWaiters.length === 2) secondDelayStarted();
          });
        },
        processAlive: async () => 'alive',
      },
    },
  );
  await owner.prepare();
  await owner.recordLaunch(150);
  const lockPath = `${fixture.scopePath}.lock`;
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      createdAtEpochMs: Date.now(),
      token: 'external-live-lock',
    })}\n`,
    'utf8',
  );

  const outstandingRefresh = owner.refresh();
  await firstDelayStartedPromise;
  const finalization = owner.finalizeFromManifest(fixture.manifestPath);
  await secondDelayStartedPromise;

  await unlinkFs(lockPath);
  // Let finalization win the lease while the already-triggered interval tick
  // remains suspended. This is the exact ordering clearInterval cannot cancel.
  delayWaiters[1]();
  await finalization;
  assert.equal(
    (
      JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
        status: string;
      }
    ).status,
    'terminal',
  );

  delayWaiters[0]();
  await outstandingRefresh;
  assert.equal(
    (
      JSON.parse(await readFile(fixture.scopePath, 'utf8')) as {
        status: string;
      }
    ).status,
    'terminal',
  );
});

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
