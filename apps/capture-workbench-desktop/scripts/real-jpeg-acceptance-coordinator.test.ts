import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

import {
  runRealJpegAcceptance,
  runRealJpegAcceptanceCli,
  type RealJpegAcceptanceAdapter,
  type RealJpegAcceptanceChild,
  type RealJpegAcceptanceChildRequest,
  type RealJpegAcceptanceInput,
} from './real-jpeg-acceptance-coordinator.ts';
import type { AcceptanceScopeProcessObservation } from './windows-acceptance-scope-probe.ts';

const MODEL_FILES = [
  ['licenses/LICENSE-PaddleOCR.txt', 'license'],
  ['licenses/NOTICE-det.md', 'det notice'],
  ['licenses/NOTICE-rec.md', 'rec notice'],
  ['model/det/inference.onnx', 'det onnx'],
  ['model/det/inference.yml', 'det yml'],
  ['model/pipeline.json', '{}'],
  ['model/rec/inference.onnx', 'rec onnx'],
  ['model/rec/inference.yml', 'rec yml'],
  ['model/rec/ppocrv6_dict.txt', 'dict'],
  ['provenance/commit-a.json', '{}'],
] as const;

const ROOT_PROCESS = {
  pid: 3000,
  creationTimeUtc: '2026-09-01T00:00:00.000Z',
  executable: 'C:\\safe\\node.exe',
  name: 'node.exe',
} as const;
const BASELINE_PROCESS = {
  pid: 4100,
  parentPid: ROOT_PROCESS.pid,
  creationTimeUtc: '2026-09-01T00:00:01.000Z',
  executable: 'C:\\safe\\ollama.exe',
  name: 'ollama.exe',
} as const;
const BASELINE_HELPER = {
  pid: 4101,
  parentPid: BASELINE_PROCESS.pid,
  creationTimeUtc: '2026-09-01T00:00:02.000Z',
  executable: 'C:\\safe\\ollama_llama_server.exe',
  name: 'ollama_llama_server.exe',
} as const;
const AMBIENT_PLAYWRIGHT = {
  pid: 9000,
  parentPid: 8999,
  creationTimeUtc: '2026-09-01T00:00:03.000Z',
  executable: 'C:\\ambient\\playwright.exe',
  name: 'playwright.exe',
} as const;
const EXTERNAL_OLLAMA = {
  pid: 9100,
  parentPid: 8999,
  creationTimeUtc: '2026-09-01T00:00:04.000Z',
  executable: 'C:\\external\\ollama.exe',
  name: 'ollama.exe',
} as const;
const AUTHORIZED_EXTERNAL_OLLAMA = {
  pid: 9200,
  parentPid: 8999,
  creationTimeUtc: '2026-09-01T00:00:05.000Z',
  executable: BASELINE_PROCESS.executable,
  name: 'ollama.exe',
} as const;
const REPLACEMENT_AUTHORIZED_EXTERNAL_OLLAMA = {
  pid: 9201,
  parentPid: 8999,
  creationTimeUtc: '2026-09-01T00:00:06.000Z',
  executable: BASELINE_PROCESS.executable,
  name: 'ollama.exe',
} as const;
const REUSED_AUTHORIZED_EXTERNAL_OLLAMA = {
  ...AUTHORIZED_EXTERNAL_OLLAMA,
  creationTimeUtc: '2026-09-01T00:00:06.500Z',
} as const;
const AUTHORIZED_EXTERNAL_HELPER = {
  pid: 9202,
  parentPid: AUTHORIZED_EXTERNAL_OLLAMA.pid,
  creationTimeUtc: '2026-09-01T00:00:06.750Z',
  executable: 'C:\\approved\\ollama_llama_server.exe',
  name: 'ollama_llama_server.exe',
} as const;
const REUSED_CONTROLLED_ROOT = {
  ...BASELINE_PROCESS,
  parentPid: 8999,
  creationTimeUtc: '2026-09-01T00:00:08.000Z',
} as const;
const AMBIENT_CAPTURE_RUNTIME = {
  pid: 9300,
  parentPid: 8999,
  creationTimeUtc: '2026-09-01T00:00:07.000Z',
  executable: 'C:\\ambient\\capture-runtime.exe',
  name: 'capture-runtime.exe',
} as const;
const CONFIGURATION_FAILURE = {
  exitCode: 1,
  stdout: '',
  stderr: 'real_jpeg_acceptance_configuration_failed\n',
} as const;

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly candidateRoot: string;
  readonly candidateId: string;
  readonly ownedRoot: string;
  readonly physicalRoot?: string;
  readonly aliasRoot?: string;
}

interface Harness {
  readonly adapter: RealJpegAcceptanceAdapter;
  readonly copyModes: Array<number | undefined>;
  readonly copiedSources: string[];
  readonly probedIdentities: Array<{
    readonly pid: number;
    readonly creationTimeUtc: string;
    readonly executable: string;
  }>;
  readonly requests: RealJpegAcceptanceChildRequest[];
  readonly trace: string[];
}

interface HarnessOptions {
  readonly ambientProcesses?: readonly AcceptanceScopeProcessObservation[];
  readonly preexistingSnapshots?: readonly {
    readonly ambientProcesses: readonly AcceptanceScopeProcessObservation[];
    readonly preoccupiedPort?: boolean;
  }[];
  readonly preoccupiedPort?: boolean;
  readonly listenerOwnerPid?: number | null;
  readonly confirmationListenerOwnerPid?: number | null;
  readonly baselineExitBeforeReady?: boolean;
  readonly readinessResult?: { readonly statusCode: number; readonly body: unknown };
  readonly readinessFailure?: boolean;
  readonly canonicalExitCode?: number;
  readonly canonicalWaitFailure?: boolean;
  readonly processStates?: Array<'present' | 'absent' | 'unknown'>;
  readonly terminateFailure?: boolean;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function identityMatches(
  actual: { readonly pid: number; readonly creationTimeUtc: string; readonly executable: string },
  expected: { readonly pid: number; readonly creationTimeUtc: string; readonly executable: string },
): boolean {
  return actual.pid === expected.pid &&
    actual.creationTimeUtc === expected.creationTimeUtc &&
    actual.executable === expected.executable;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

async function createFixture(options: { readonly ancestorAlias?: boolean } = {}): Promise<Fixture> {
  const physicalRoot = await mkdtemp(join(tmpdir(), 'capture-j53-coordinator-'));
  let root = physicalRoot;
  let aliasRoot: string | undefined;
  if (options.ancestorAlias) {
    aliasRoot = join(
      tmpdir(),
      `capture-j53-coordinator-alias-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await symlink(physicalRoot, aliasRoot, 'junction');
    assert.notEqual(await realpath(aliasRoot), aliasRoot);
    root = join(aliasRoot, 'run');
    await mkdir(root, { recursive: true });
  }
  const sourceRoot = join(root, 'source-model');
  const candidateRoot = join(root, 'candidate');
  const ownedRoot = join(root, 'owned');
  const files = MODEL_FILES.map(([path, contents]) => ({
    bytes: Buffer.byteLength(contents),
    path,
    sha256: sha256(contents),
  }));
  const modelManifest = {
    artifactVersion: '0.4.2',
    entryPoint: 'model',
    files,
    manifestVersion: '1',
  };
  const descriptor = {
    artifactVersion: '0.4.2',
    entryCount: files.length,
    entryPoint: 'model',
    extractedBytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
    manifestSha256: sha256(
      `${JSON.stringify(canonicalize(modelManifest), null, 2)}\n`,
    ),
    sourceLockSha256: 'b'.repeat(64),
  };
  for (const [path, contents] of MODEL_FILES) {
    const filePath = join(sourceRoot, ...path.split('/'));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }
  // This legacy extra is intentionally not part of the descriptor. The
  // coordinator must never enumerate or copy it.
  await mkdir(join(sourceRoot, 'legacy-empty-extra'), { recursive: true });

  const catalogPath = join(candidateRoot, 'runtime', 'capture-engine-catalog.json');
  await mkdir(dirname(catalogPath), { recursive: true });
  const catalogBytes = Buffer.from(JSON.stringify({
    catalogVersion: '2',
    runtimeVersion: '0.4.2',
    requirements: [{
      requirementId: 'windowsml-ocr',
      modelFiles: descriptor,
    }],
  }));
  await writeFile(catalogPath, catalogBytes);
  const manifestBase = {
    artifacts: [{
      path: 'runtime/capture-engine-catalog.json',
      bytes: catalogBytes.length,
      sha256: sha256(catalogBytes),
    }],
    candidateKind: 'runtime',
    contractSetSha256: 'a'.repeat(64),
    packageCandidateId: 'b'.repeat(64),
    producerRunId: 1,
    releaseMode: 'core-only',
    releaseVersion: '0.4.2',
    schemaVersion: '1',
    sourceCommit: 'c'.repeat(40),
    toolchains: { node: '24', python: '3.12', runtime: 'capture-runtime' },
  };
  const candidateId = sha256(JSON.stringify(manifestBase));
  await writeFile(
    join(candidateRoot, 'candidate-manifest.json'),
    JSON.stringify({ ...manifestBase, candidateId }),
  );
  return {
    root,
    sourceRoot,
    candidateRoot,
    candidateId,
    ownedRoot,
    ...(options.ancestorAlias ? { physicalRoot, aliasRoot } : {}),
  };
}

function inputFor(fixture: Fixture): RealJpegAcceptanceInput {
  return {
    workspaceRoot: fixture.root,
    ownershipRoot: fixture.root,
    ownedRoot: fixture.ownedRoot,
    jpegPath: join(fixture.root, 'private-fixture.jpeg'),
    installedExecutablePath: join(fixture.root, 'installed.exe'),
    installerProvenancePath: join(fixture.root, 'installer.provenance.json'),
    runtimeCandidateRoot: fixture.candidateRoot,
    runtimeCandidateId: fixture.candidateId,
    modelSourceRoot: fixture.sourceRoot,
    ollamaExecutablePath: BASELINE_PROCESS.executable,
    baselinePort: 18443,
    runId: 'j53-private-run',
    parentEnvironment: {
      PATH: 'C:\\safe',
      OLLAMA_HOST: 'http://127.0.0.1:19999',
      ollama_models: 'C:\\unowned-models',
      CAPTURE_OLLAMA_HOST: 'http://127.0.0.1:19998',
      J53_PRIVATE_CANARY: 'do-not-inherit',
    },
  };
}

function environmentFor(
  input: RealJpegAcceptanceInput,
): NodeJS.ProcessEnv {
  return {
    PATH: 'C:\\safe',
    J53_WORKSPACE_ROOT: input.workspaceRoot,
    J53_OWNERSHIP_ROOT: input.ownershipRoot,
    J53_OWNED_ROOT: input.ownedRoot,
    J53_JPEG_PATH: input.jpegPath,
    J53_INSTALLED_EXECUTABLE_PATH: input.installedExecutablePath,
    J53_INSTALLER_PROVENANCE_PATH: input.installerProvenancePath,
    J53_RUNTIME_CANDIDATE_ROOT: input.runtimeCandidateRoot,
    J53_RUNTIME_CANDIDATE_ID: input.runtimeCandidateId,
    J53_MODEL_SOURCE_ROOT: input.modelSourceRoot,
    J53_OLLAMA_EXECUTABLE_PATH: input.ollamaExecutablePath,
    J53_BASELINE_PORT: String(input.baselinePort),
    J53_RUN_ID: input.runId,
  };
}

function createHarness(port = 18443, options: HarnessOptions = {}): Harness {
  const requests: RealJpegAcceptanceChildRequest[] = [];
  const copyModes: Array<number | undefined> = [];
  const copiedSources: string[] = [];
  const probedIdentities: Array<{
    readonly pid: number;
    readonly creationTimeUtc: string;
    readonly executable: string;
  }> = [];
  const trace: string[] = [];
  let baselineSpawned = false;
  let terminated = false;
  let readinessRequested = false;
  let currentTime = 0;
  let preexistingSnapshotIndex = 0;
  const ambientProcesses = options.ambientProcesses ?? [AMBIENT_PLAYWRIGHT];
  const baselineChild: RealJpegAcceptanceChild = {
    pid: BASELINE_PROCESS.pid,
    get exitCode() {
      if (terminated) return 0;
      return baselineSpawned && options.baselineExitBeforeReady ? 1 : null;
    },
    get signalCode() {
      return null;
    },
    waitForExit: async () => 0,
  };
  const canonicalChild: RealJpegAcceptanceChild = {
    pid: 4200,
    exitCode: options.canonicalExitCode ?? 0,
    signalCode: null,
    waitForExit: async () => {
      trace.push('canonical:exit');
      if (options.canonicalWaitFailure) {
        throw new Error('private canonical wait canary');
      }
      return options.canonicalExitCode ?? 0;
    },
  };
  return {
    copyModes,
    copiedSources,
    probedIdentities,
    requests,
    trace,
    adapter: {
      coordinatorPid: ROOT_PROCESS.pid,
      files: {
        copyFile: async (source, target, mode) => {
          copiedSources.push(source);
          copyModes.push(mode);
          await copyFile(source, target, mode);
        },
        lstat,
        mkdir,
        realpath,
        rename,
        rm,
      },
      nodeExecutable: 'C:\\safe\\node.exe',
      now: () => currentTime,
      delay: async (milliseconds) => {
        currentTime += milliseconds;
      },
      snapshot: async () => {
        trace.push('scope:snapshot');
        if (!baselineSpawned) {
          const configured = options.preexistingSnapshots?.[
            Math.min(
              preexistingSnapshotIndex++,
              Math.max((options.preexistingSnapshots?.length ?? 1) - 1, 0),
            )
          ];
          const observedAmbient = configured?.ambientProcesses ?? ambientProcesses;
          const portPreoccupied = configured?.preoccupiedPort ??
            options.preoccupiedPort;
          return {
            processes: [ROOT_PROCESS, ...observedAmbient],
            listeners: portPreoccupied
              ? [{
                  host: '127.0.0.1' as const,
                  port,
                  protocol: 'tcp' as const,
                  owningPid: AMBIENT_PLAYWRIGHT.pid,
                }]
              : [],
          };
        }
        if (terminated) {
          return {
            processes: [ROOT_PROCESS, ...ambientProcesses],
            listeners: options.preoccupiedPort
              ? [{
                  host: '127.0.0.1' as const,
                  port,
                  protocol: 'tcp' as const,
                  owningPid: AMBIENT_PLAYWRIGHT.pid,
                }]
              : [],
          };
        }
        if (options.baselineExitBeforeReady) {
          return {
            processes: [ROOT_PROCESS, ...ambientProcesses],
            listeners: [],
          };
        }
        const configuredListenerOwner = readinessRequested &&
          options.confirmationListenerOwnerPid !== undefined
          ? options.confirmationListenerOwnerPid
          : options.listenerOwnerPid;
        const listenerOwnerPid = configuredListenerOwner === undefined
          ? BASELINE_HELPER.pid
          : configuredListenerOwner;
        return {
          processes: [
            ROOT_PROCESS,
            BASELINE_PROCESS,
            BASELINE_HELPER,
            ...ambientProcesses,
          ],
          listeners: listenerOwnerPid === null
            ? []
            : [{
                host: '127.0.0.1',
                port,
                protocol: 'tcp',
                owningPid: listenerOwnerPid,
              }],
        };
      },
      processState: async (identity) => {
        trace.push(`probe:${String(identity.pid)}`);
        probedIdentities.push({ ...identity });
        const isTracked = [BASELINE_PROCESS, BASELINE_HELPER].some(
          (expected) =>
            identity.pid === expected.pid &&
            identity.creationTimeUtc === expected.creationTimeUtc &&
            identity.executable === expected.executable,
        );
        return options.processStates?.shift() ??
          (isTracked ? (terminated ? 'absent' : 'present') : 'unknown');
      },
      requestJson: async (url) => {
        trace.push(`http:${url}`);
        readinessRequested = true;
        if (options.readinessFailure) {
          throw new Error('private readiness canary');
        }
        return options.readinessResult ?? { statusCode: 200, body: { models: [] } };
      },
      spawnChild: (request) => {
        requests.push(request);
        trace.push(`spawn:${request.kind}`);
        if (request.kind === 'baseline') {
          baselineSpawned = true;
          return baselineChild;
        }
        return canonicalChild;
      },
      terminateTrackedProcessTree: async (child) => {
        assert.equal(child, baselineChild);
        trace.push('terminate:baseline');
        if (options.terminateFailure) {
          throw new Error('private termination canary');
        }
        terminated = true;
      },
    },
  };
}

test('CLI composition maps all twelve exact J53 bindings into one typed input', async () => {
  const fixture = await createFixture();
  const expected = inputFor(fixture);
  const environment = environmentFor(expected);
  const harness = createHarness(expected.baselinePort);
  let observed: RealJpegAcceptanceInput | undefined;
  try {
    await runRealJpegAcceptanceCli(environment, (input) => {
      observed = input;
      return harness.adapter;
    });

    assert.deepEqual(observed, {
      ...expected,
      parentEnvironment: environment,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI configuration rejects missing, blank, every C0 or DEL control, and invalid ports before adapter construction', async () => {
  const fixture = await createFixture();
  const expected = inputFor(fixture);
  const invalidEnvironments: Array<{
    readonly name: string;
    readonly environment: NodeJS.ProcessEnv;
  }> = [];

  const missing = environmentFor(expected);
  delete missing.J53_JPEG_PATH;
  invalidEnvironments.push({ name: 'missing', environment: missing });
  invalidEnvironments.push({
    name: 'empty',
    environment: { ...environmentFor(expected), J53_JPEG_PATH: '' },
  });
  invalidEnvironments.push({
    name: 'whitespace-only',
    environment: { ...environmentFor(expected), J53_JPEG_PATH: '   ' },
  });
  for (const codePoint of [...Array.from({ length: 0x20 }, (_, index) => index), 0x7f]) {
    invalidEnvironments.push({
      name: `control U+${codePoint.toString(16).padStart(4, '0')}`,
      environment: {
        ...environmentFor(expected),
        J53_JPEG_PATH: `private${String.fromCodePoint(codePoint)}canary`,
      },
    });
  }
  for (const port of [
    '+18443',
    '-1',
    ' 18443',
    '18443 ',
    '1e3',
    '18443.0',
    'abc',
    '0',
    '65536',
    '999999999999999999999999999999999999999999',
  ]) {
    invalidEnvironments.push({
      name: `port ${JSON.stringify(port)}`,
      environment: { ...environmentFor(expected), J53_BASELINE_PORT: port },
    });
  }

  try {
    for (const { name, environment } of invalidEnvironments) {
      const harness = createHarness(expected.baselinePort);
      let adapterConstructions = 0;
      const result = await runRealJpegAcceptanceCli(environment, () => {
        adapterConstructions += 1;
        return harness.adapter;
      });

      assert.deepEqual(result, CONFIGURATION_FAILURE, name);
      assert.equal(adapterConstructions, 0, name);
      assert.equal(harness.requests.length, 0, name);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI accepts twelve singleton case-insensitive bindings and rejects every case-fold duplicate', async () => {
  const fixture = await createFixture();
  const expected = inputFor(fixture);
  const canonical = environmentFor(expected);
  const singletonAliases = Object.fromEntries(
    Object.entries(canonical).map(([key, value]) => [
      key.startsWith('J53_') ? key.toLowerCase() : key,
      value,
    ]),
  );
  const singletonHarness = createHarness(expected.baselinePort);
  let singletonInput: RealJpegAcceptanceInput | undefined;
  try {
    const singletonResult = await runRealJpegAcceptanceCli(
      singletonAliases,
      (input) => {
        singletonInput = input;
        return singletonHarness.adapter;
      },
    );
    assert.equal(singletonResult.exitCode, 0);
    assert.deepEqual(singletonInput, {
      ...expected,
      parentEnvironment: singletonAliases,
    });

    for (const key of Object.keys(canonical).filter((item) =>
      item.startsWith('J53_')
    )) {
      const value = canonical[key];
      assert.equal(typeof value, 'string');
      for (const duplicateValue of [value, `${value}-conflict`]) {
        const environment = {
          ...canonical,
          [key.toLowerCase()]: duplicateValue,
        };
        const harness = createHarness(expected.baselinePort);
        let adapterConstructions = 0;
        const result = await runRealJpegAcceptanceCli(environment, () => {
          adapterConstructions += 1;
          return harness.adapter;
        });

        assert.deepEqual(
          result,
          CONFIGURATION_FAILURE,
          `${key} duplicate ${duplicateValue === value ? 'same' : 'different'}`,
        );
        assert.equal(adapterConstructions, 0, key);
        assert.equal(harness.requests.length, 0, key);
      }
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI keeps its parent environment immutable and scrubs every private canary from both children', async () => {
  const fixture = await createFixture();
  const expected = inputFor(fixture);
  const environment = Object.freeze({
    ...environmentFor(expected),
    J53_PRIVATE_CANARY: 'private-j53-value',
    capture_j53_private_canary: 'private-capture-j53-value',
    OLLAMA_PRIVATE_CANARY: 'private-ollama-value',
    capture_ollama_private_canary: 'private-capture-ollama-value',
  });
  const original = { ...environment };
  const harness = createHarness(expected.baselinePort);
  let observedParent: Readonly<NodeJS.ProcessEnv> | undefined;
  try {
    const result = await runRealJpegAcceptanceCli(environment, (input) => {
      observedParent = input.parentEnvironment;
      return harness.adapter;
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(environment, original);
    assert.notEqual(observedParent, environment);
    assert.deepEqual(observedParent, environment);
    assert.deepEqual(
      harness.requests.map(({ kind, environment: childEnvironment }) => ({
        kind,
        privateKeys: Object.keys(childEnvironment).filter((key) =>
          key.toUpperCase().endsWith('_PRIVATE_CANARY')
        ),
        privateValues: Object.values(childEnvironment).filter((value) =>
          typeof value === 'string' && value.startsWith('private-')
        ),
      })),
      [
        { kind: 'baseline', privateKeys: [], privateValues: [] },
        { kind: 'canonical', privateKeys: [], privateValues: [] },
      ],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI serializes a passed result as one JSON line with exit zero', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  try {
    const result = await runRealJpegAcceptanceCli(
      environmentFor(input),
      () => harness.adapter,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.match(/\n/gu)?.length, 1);
    assert.ok(result.stdout.endsWith('\n'));
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'passed',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: true,
      canonicalStarted: true,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI serializes a failed result as one JSON line with exit one', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort, { preoccupiedPort: true });
  try {
    const result = await runRealJpegAcceptanceCli(
      environmentFor(input),
      () => harness.adapter,
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.match(/\n/gu)?.length, 1);
    assert.ok(result.stdout.endsWith('\n'));
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'failed',
      failureCode: 'baseline_port_preoccupied',
      projectionVerified: false,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(harness.requests.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI sanitizes an adapter construction error before any child request', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  try {
    const result = await runRealJpegAcceptanceCli(environmentFor(input), () => {
      throw new Error('private adapter construction canary');
    });

    assert.deepEqual(result, CONFIGURATION_FAILURE);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /private adapter construction canary/iu,
    );
    assert.equal(harness.requests.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('direct Node entrypoint with a missing key exits one with empty stdout and fixed sanitized stderr', () => {
  const privateCanary = 'private-direct-entry-canary';
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
  ]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  environment.J53_PRIVATE_CANARY = privateCanary;

  const child = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'real-jpeg-acceptance-coordinator.ts')],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: environment,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );

  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'real_jpeg_acceptance_configuration_failed\n');
  assert.doesNotMatch(`${child.stdout}${child.stderr}`, new RegExp(privateCanary, 'u'));
});

test('the linked coordinator runs the exact baseline and canonical contract without mutating the parent environment', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  Object.freeze(input.parentEnvironment);
  const originalEnvironment = { ...input.parentEnvironment };
  const harness = createHarness(input.baselinePort);
  try {
    const result = await runRealJpegAcceptance(input, harness.adapter);

    assert.deepEqual(result, {
      status: 'passed',
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: true,
      canonicalStarted: true,
      canonicalExitCode: 0,
    });
    assert.deepEqual(input.parentEnvironment, originalEnvironment);
    const canonicalFixtureRoot = await realpath(fixture.root);
    const canonicalOwnedRoot = join(canonicalFixtureRoot, 'owned');
    const canonicalSourceRoot = await realpath(fixture.sourceRoot);
    assert.deepEqual(
      harness.copiedSources.map((source) =>
        relative(canonicalSourceRoot, source).replaceAll('\\', '/'),
      ),
      MODEL_FILES.map(([path]) => path),
    );
    assert.deepEqual(
      harness.copyModes,
      Array.from({ length: MODEL_FILES.length }, () => fsConstants.COPYFILE_EXCL),
    );
    assert.equal(harness.requests.length, 2);
    const [baseline, canonical] = harness.requests;
    assert.equal(baseline.kind, 'baseline');
    assert.equal(baseline.command, BASELINE_PROCESS.executable);
    assert.deepEqual(baseline.args, ['serve']);
    assert.equal(baseline.cwd, input.workspaceRoot);
    assert.deepEqual(
      Object.keys(baseline.environment)
        .filter((key) => /^(?:CAPTURE_)?OLLAMA_/iu.test(key))
        .sort(),
      ['OLLAMA_HOST', 'OLLAMA_MODELS'],
    );
    assert.equal(
      Object.keys(baseline.environment).some(
        (key) => key.toUpperCase().startsWith('CAPTURE_') || key.toUpperCase().startsWith('E2E_'),
      ),
      false,
    );
    assert.equal(
      baseline.environment.OLLAMA_HOST,
      `http://127.0.0.1:${String(input.baselinePort)}`,
    );
    assert.equal(
      baseline.environment.OLLAMA_MODELS,
      join(canonicalOwnedRoot, 'baseline-ollama-models'),
    );
    assert.equal(baseline.environment.J53_PRIVATE_CANARY, undefined);
    assert.equal(canonical.kind, 'canonical');
    assert.equal(canonical.command, harness.adapter.nodeExecutable);
    assert.deepEqual(canonical.args, [
      'tools/three-project-acceptance.ts',
      '--capture-workbench-only',
    ]);
    assert.equal(canonical.cwd, input.workspaceRoot);
    assert.equal(
      Object.keys(canonical.environment).some(
        (key) => /^(?:CAPTURE_)?OLLAMA_/iu.test(key),
      ),
      false,
    );
    assert.deepEqual(
      Object.keys(canonical.environment)
        .filter((key) => key.toUpperCase().startsWith('CAPTURE_'))
        .sort(),
      [
        'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN',
        'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT',
        'CAPTURE_REAL_DESKTOP_EXECUTABLE',
        'CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE',
        'CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE',
        'CAPTURE_REAL_DESKTOP_OCR_INPUT',
        'CAPTURE_REAL_DESKTOP_TEARDOWN',
        'CAPTURE_RUNTIME_CANDIDATE_ID',
        'CAPTURE_RUNTIME_CANDIDATE_ROOT',
      ],
    );
    assert.equal(canonical.environment.CAPTURE_REAL_DESKTOP_OCR_INPUT, input.jpegPath);
    assert.equal(
      canonical.environment.CAPTURE_REAL_DESKTOP_EXECUTABLE,
      input.installedExecutablePath,
    );
    assert.equal(
      canonical.environment.CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE,
      input.installerProvenancePath,
    );
    assert.equal(
      canonical.environment.CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE,
      'windowsml-dml',
    );
    assert.equal(canonical.environment.CAPTURE_REAL_DESKTOP_TEARDOWN, 'window-close');
    assert.equal(
      canonical.environment.CAPTURE_RUNTIME_CANDIDATE_ROOT,
      input.runtimeCandidateRoot,
    );
    assert.equal(
      canonical.environment.CAPTURE_RUNTIME_CANDIDATE_ID,
      input.runtimeCandidateId,
    );
    assert.equal(
      canonical.environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN,
      '1',
    );
    assert.equal(
      canonical.environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT,
      join(canonicalOwnedRoot, 'model-projection'),
    );
    assert.equal(canonical.environment.E2E_RECORD_VIDEO, '0');
    assert.equal(canonical.environment.J53_PRIVATE_CANARY, undefined);
    assert.notEqual(
      baseline.environment.OLLAMA_MODELS,
      canonical.environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT,
    );
    assert.ok(
      harness.trace.indexOf('spawn:baseline') <
        harness.trace.indexOf(`http:http://127.0.0.1:${String(input.baselinePort)}/api/tags`),
    );
    assert.ok(
      harness.trace.indexOf(`http:http://127.0.0.1:${String(input.baselinePort)}/api/tags`) <
        harness.trace.indexOf('spawn:canonical'),
    );
    assert.ok(
      harness.trace.indexOf('canonical:exit') <
        harness.trace.indexOf('terminate:baseline'),
    );
    assert.ok(
      harness.trace.indexOf('terminate:baseline') <
        harness.trace.lastIndexOf(`probe:${String(BASELINE_HELPER.pid)}`),
    );
    assert.ok(
      harness.probedIdentities.some((identity) =>
        identityMatches(identity, BASELINE_PROCESS),
      ),
    );
    assert.ok(
      harness.probedIdentities.some((identity) =>
        identityMatches(identity, BASELINE_HELPER),
      ),
    );
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('the coordinator accepts an ancestor junction alias while preserving the baseline and canonical launches', async () => {
  const fixture = await createFixture({ ancestorAlias: true });
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  try {
    const result = await runRealJpegAcceptance(input, harness.adapter);

    assert.deepEqual(result, {
      status: 'passed',
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: true,
      canonicalStarted: true,
      canonicalExitCode: 0,
    });
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['baseline', 'canonical'],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    if (fixture.aliasRoot) await rm(fixture.aliasRoot, { force: true });
    if (fixture.physicalRoot) await rm(fixture.physicalRoot, { recursive: true, force: true });
  }
});

test('the strict projection verifier rejects an injected target extra before either child starts', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    files: {
      ...harness.adapter.files,
      rename: async (source, target) => {
        await rename(source, target);
        await mkdir(join(target, 'unexpected-empty-extra'));
      },
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      failureCode: 'projection_verification_failed',
      projectionVerified: false,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(harness.requests.length, 0);
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('the clean projection rejects the control-file exception accepted by the reusable verifier', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    files: {
      ...harness.adapter.files,
      rename: async (source, target) => {
        await rename(source, target);
        await writeFile(
          join(target, 'transport-manifest.json'),
          'private control canary',
          'utf8',
        );
      },
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.equal(result.failureCode, 'projection_verification_failed');
    assert.equal(result.canonicalStarted, false);
    assert.equal(harness.requests.length, 0);
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate authority failure is delegated and stops before materialization or process launch', async () => {
  const fixture = await createFixture();
  const input = {
    ...inputFor(fixture),
    runtimeCandidateId: 'd'.repeat(64),
  };
  const harness = createHarness(input.baselinePort);
  try {
    const result = await runRealJpegAcceptance(input, harness.adapter);

    assert.deepEqual(result, {
      status: 'failed',
      failureCode: 'authority_verification_failed',
      projectionVerified: false,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(harness.requests.length, 0);
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a descriptor path traversal is rejected by the authenticated parser before materialization', async () => {
  const fixture = await createFixture();
  const catalogPath = join(
    fixture.candidateRoot,
    'runtime',
    'capture-engine-catalog.json',
  );
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
    requirements: Array<{
      modelFiles: { files: Array<{ path: string }> };
    }>;
  };
  catalog.requirements[0].modelFiles.files[0].path = '../outside-private-canary';
  const catalogBytes = Buffer.from(JSON.stringify(catalog));
  await writeFile(catalogPath, catalogBytes);
  const manifestPath = join(fixture.candidateRoot, 'candidate-manifest.json');
  const manifestBase = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    candidateId?: string;
    artifacts: Array<{ path: string; bytes: number; sha256: string }>;
    [key: string]: unknown;
  };
  delete manifestBase.candidateId;
  manifestBase.artifacts[0] = {
    path: 'runtime/capture-engine-catalog.json',
    bytes: catalogBytes.length,
    sha256: sha256(catalogBytes),
  };
  const candidateId = sha256(JSON.stringify(manifestBase));
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifestBase, candidateId }),
  );
  const input = { ...inputFor(fixture), runtimeCandidateId: candidateId };
  const harness = createHarness(input.baselinePort);
  try {
    const result = await runRealJpegAcceptance(input, harness.adapter);

    assert.equal(result.failureCode, 'authority_verification_failed');
    assert.equal(harness.requests.length, 0);
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('canonical plan validation fails before baseline side effects for an unsafe run id', async () => {
  const fixture = await createFixture();
  const input = {
    ...inputFor(fixture),
    runId: 'unsafe run id',
  };
  const harness = createHarness(input.baselinePort);
  try {
    const result = await runRealJpegAcceptance(input, harness.adapter);

    assert.equal(result.failureCode, 'invalid_input');
    assert.equal(result.projectionVerified, true);
    assert.equal(result.canonicalStarted, false);
    assert.equal(harness.requests.length, 0);
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function assertProjectionMaterializationFailure(
  arrange: (
    fixture: Fixture,
    harness: Harness,
  ) => Promise<RealJpegAcceptanceAdapter>,
): Promise<void> {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  try {
    const adapter = await arrange(fixture, harness);
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      failureCode: 'projection_materialization_failed',
      projectionVerified: false,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(harness.requests.length, 0);
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test('descriptor-only materialization rejects a source size mismatch', async () => {
  await assertProjectionMaterializationFailure(async (fixture, harness) => {
    await writeFile(
      join(fixture.sourceRoot, 'model', 'det', 'inference.yml'),
      'different-size',
      'utf8',
    );
    return harness.adapter;
  });
});

test('descriptor-only materialization rejects same-size source SHA drift', async () => {
  await assertProjectionMaterializationFailure(async (fixture, harness) => {
    await writeFile(
      join(fixture.sourceRoot, 'model', 'det', 'inference.yml'),
      'bad yml',
      'utf8',
    );
    return harness.adapter;
  });
});

test('descriptor-only materialization rejects a source reparse observation', async () => {
  await assertProjectionMaterializationFailure(async (fixture, harness) => {
    const linkedSource = join(fixture.sourceRoot, 'model', 'det', 'inference.yml');
    return {
      ...harness.adapter,
      files: {
        ...harness.adapter.files,
        lstat: async (path) => {
          const metadata = await lstat(path);
          if (path !== linkedSource) return metadata;
          return {
            size: metadata.size,
            isDirectory: () => metadata.isDirectory(),
            isFile: () => metadata.isFile(),
            isSymbolicLink: () => true,
          };
        },
      },
    };
  });
});

test('descriptor-only materialization rejects a reparse source root', async () => {
  await assertProjectionMaterializationFailure(async (fixture, harness) => ({
    ...harness.adapter,
    files: {
      ...harness.adapter.files,
      lstat: async (path) => {
        const metadata = await lstat(path);
        if (path !== fixture.sourceRoot) return metadata;
        return {
          size: metadata.size,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      },
    },
  }));
});

test('descriptor-only materialization rejects a source realpath escape', async () => {
  await assertProjectionMaterializationFailure(async (fixture, harness) => {
    const escapingSource = join(fixture.sourceRoot, 'model', 'det', 'inference.yml');
    return {
      ...harness.adapter,
      files: {
        ...harness.adapter.files,
        realpath: async (path) =>
          path === escapingSource
            ? join(fixture.root, 'outside-private-canary')
            : realpath(path),
      },
    };
  });
});

test('owned-root creation refuses an intermediate parent that resolves outside authority', async () => {
  const fixture = await createFixture();
  const intermediate = join(fixture.root, 'owned-parent');
  await mkdir(intermediate);
  const input = {
    ...inputFor(fixture),
    ownedRoot: join(intermediate, 'owned'),
  };
  const harness = createHarness(input.baselinePort);
  let ownedRootCreated = false;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    files: {
      ...harness.adapter.files,
      mkdir: async (path, options) => {
        if (path === input.ownedRoot) ownedRootCreated = true;
        return mkdir(path, options);
      },
      realpath: async (path) =>
        path === intermediate
          ? join(dirname(fixture.root), 'outside-authority-canary')
          : realpath(path),
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.equal(result.failureCode, 'projection_materialization_failed');
    assert.equal(ownedRootCreated, false);
    assert.equal(harness.requests.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function runHarnessScenario(
  options: HarnessOptions,
): Promise<{
  readonly result: Awaited<ReturnType<typeof runRealJpegAcceptance>>;
  readonly fixture: Fixture;
  readonly harness: Harness;
  cleanup(): Promise<void>;
}> {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort, options);
  const result = await runRealJpegAcceptance(input, harness.adapter);
  return {
    result,
    fixture,
    harness,
    cleanup: () => rm(fixture.root, { recursive: true, force: true }),
  };
}

test('an occupied immutable port fails before the one allowed baseline launch', async () => {
  const scenario = await runHarnessScenario({ preoccupiedPort: true });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_port_preoccupied',
      projectionVerified: false,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(scenario.harness.requests.length, 0);
  } finally {
    await scenario.cleanup();
  }
});

test('a preflight failure never deletes an existing path merely named as the owned root', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const sentinel = join(fixture.ownedRoot, 'preexisting-private-canary.txt');
  await mkdir(fixture.ownedRoot);
  await writeFile(sentinel, 'must survive', 'utf8');
  const harness = createHarness(input.baselinePort, { preoccupiedPort: true });
  try {
    const result = await runRealJpegAcceptance(input, harness.adapter);

    assert.equal(result.failureCode, 'baseline_port_preoccupied');
    assert.equal((await lstat(sentinel)).isFile(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a post-spawn foreign listener is a stable collision and never starts canonical', async () => {
  const scenario = await runHarnessScenario({
    listenerOwnerPid: AMBIENT_PLAYWRIGHT.pid,
  });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_port_collision',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['baseline'],
    );
    assert.equal(
      scenario.harness.trace.filter((entry) => entry === 'terminate:baseline').length,
      1,
    );
  } finally {
    await scenario.cleanup();
  }
});

test('one owned listener cannot hide a second foreign listener on the immutable port', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    snapshot: async () => {
      const scope = await harness.adapter.snapshot();
      if (!harness.requests.some((request) => request.kind === 'baseline')) {
        return scope;
      }
      return {
        ...scope,
        listeners: [
          ...scope.listeners,
          {
            host: '127.0.0.1',
            port: input.baselinePort,
            protocol: 'tcp',
            owningPid: AMBIENT_PLAYWRIGHT.pid,
          },
        ],
      };
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.equal(result.failureCode, 'baseline_port_collision');
    assert.equal(result.canonicalStarted, false);
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['baseline'],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a root exit before readiness is red without relaunch or canonical', async () => {
  const scenario = await runHarnessScenario({ baselineExitBeforeReady: true });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_root_exited_before_ready',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: false,
      cleanupFailureCode: 'baseline_cleanup_failed',
      canonicalStarted: false,
    });
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['baseline'],
    );
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
    assert.equal((await lstat(scenario.fixture.ownedRoot)).isDirectory(), true);
  } finally {
    await scenario.cleanup();
  }
});

test('owned-listener HTTP with an invalid tags shape fails readiness once', async () => {
  const scenario = await runHarnessScenario({
    readinessResult: { statusCode: 200, body: { models: 'invalid' } },
  });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_readiness_invalid',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(
      scenario.harness.trace.filter((entry) => entry.startsWith('http:')).length,
      1,
    );
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['baseline'],
    );
  } finally {
    await scenario.cleanup();
  }
});

test('owned-listener HTTP 503 is a stable invalid-readiness failure', async () => {
  const scenario = await runHarnessScenario({
    readinessResult: { statusCode: 503, body: { models: [] } },
  });
  try {
    assert.equal(scenario.result.failureCode, 'baseline_readiness_invalid');
    assert.equal(scenario.result.canonicalStarted, false);
    assert.equal(
      scenario.harness.trace.filter((entry) => entry.startsWith('http:')).length,
      1,
    );
  } finally {
    await scenario.cleanup();
  }
});

test('readiness exceptions stay path-free and content-free', async () => {
  const scenario = await runHarnessScenario({ readinessFailure: true });
  try {
    assert.equal(scenario.result.failureCode, 'baseline_readiness_invalid');
    assert.doesNotMatch(
      JSON.stringify(scenario.result),
      /private readiness canary|capture-j53-coordinator/iu,
    );
  } finally {
    await scenario.cleanup();
  }
});

test('listener ownership changing on the confirmation snapshot is collision red', async () => {
  const scenario = await runHarnessScenario({
    confirmationListenerOwnerPid: AMBIENT_PLAYWRIGHT.pid,
  });
  try {
    assert.equal(scenario.result.failureCode, 'baseline_port_collision');
    assert.equal(scenario.result.canonicalStarted, false);
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['baseline'],
    );
  } finally {
    await scenario.cleanup();
  }
});

test('the bounded readiness deadline is one launch gate, not a worker timeout or retry', async () => {
  const scenario = await runHarnessScenario({ listenerOwnerPid: null });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_readiness_deadline_exceeded',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['baseline'],
    );
    assert.equal(
      scenario.harness.trace.some((entry) => entry === 'canonical:exit'),
      false,
    );
  } finally {
    await scenario.cleanup();
  }
});

test('loss of the exact root identity after readiness prevents canonical launch', async () => {
  const scenario = await runHarnessScenario({ processStates: ['absent'] });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_root_lost_before_canonical',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['baseline'],
    );
  } finally {
    await scenario.cleanup();
  }
});

test('baseline spawn failure is attempted once and canonical is never attempted', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  let spawnAttempts = 0;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    spawnChild: async () => {
      spawnAttempts += 1;
      throw new Error('private spawn canary');
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      failureCode: 'baseline_spawn_failed',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(spawnAttempts, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('canonical spawn failure is attempted once after one baseline and still cleans the baseline', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  let canonicalAttempts = 0;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    spawnChild: async (request) => {
      if (request.kind === 'canonical') {
        canonicalAttempts += 1;
        throw new Error('private canonical spawn canary');
      }
      return harness.adapter.spawnChild(request);
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      failureCode: 'canonical_spawn_failed',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(canonicalAttempts, 1);
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['baseline'],
    );
    assert.equal(harness.trace.includes('terminate:baseline'), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a nonzero canonical exit is primary red while the controlled baseline survives then cleans', async () => {
  const scenario = await runHarnessScenario({ canonicalExitCode: 17 });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'canonical_acceptance_failed',
      canonicalExitCode: 17,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: true,
      canonicalStarted: true,
    });
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['baseline', 'canonical'],
    );
  } finally {
    await scenario.cleanup();
  }
});

test('canonical wait exceptions are sanitized into a nonzero canonical verdict', async () => {
  const scenario = await runHarnessScenario({ canonicalWaitFailure: true });
  try {
    assert.equal(scenario.result.failureCode, 'canonical_acceptance_failed');
    assert.equal(scenario.result.canonicalExitCode, 1);
    assert.equal(scenario.result.baselinePreserved, true);
    assert.equal(scenario.result.cleanupComplete, true);
    assert.doesNotMatch(
      JSON.stringify(scenario.result),
      /private canonical wait canary|capture-j53-coordinator/iu,
    );
  } finally {
    await scenario.cleanup();
  }
});

test('an unknown post-canonical baseline survival probe is primary red while cleanup remains independently green', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort, {
    processStates: ['present', 'unknown', 'present'],
  });
  const observedStates: Array<'present' | 'absent' | 'unknown'> = [];
  const observedAfterCanonicalExit: boolean[] = [];
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    processState: async (identity) => {
      const state = await harness.adapter.processState(identity);
      observedStates.push(state);
      observedAfterCanonicalExit.push(harness.trace.includes('canonical:exit'));
      return state;
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      failureCode: 'baseline_not_preserved_after_canonical',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: true,
    });
    assert.deepEqual(observedStates.slice(0, 3), ['present', 'unknown', 'present']);
    assert.deepEqual(observedAfterCanonicalExit.slice(0, 3), [false, true, true]);
    assert.equal(
      harness.probedIdentities.slice(0, 3).every((identity) =>
        identityMatches(identity, BASELINE_PROCESS)
      ),
      true,
    );
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an authorized external Ollama is observed while its unrelated port stays outside coordinator policy', async () => {
  const scenario = await runHarnessScenario({
    ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
    preoccupiedPort: true,
    processStates: ['present', 'present'],
  });
  try {
    assert.deepEqual(scenario.result, {
      status: 'passed',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: true,
      canonicalStarted: true,
    });
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['canonical'],
    );
    assert.equal(
      scenario.harness.trace.some((entry) => entry.startsWith('http:')),
      false,
    );
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
    assert.deepEqual(
      scenario.harness.probedIdentities,
      [AUTHORIZED_EXTERNAL_OLLAMA, AUTHORIZED_EXTERNAL_OLLAMA].map(
        ({ pid, creationTimeUtc, executable }) => ({
          pid,
          creationTimeUtc,
          executable,
        }),
      ),
    );
    await assert.rejects(lstat(scenario.fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await scenario.cleanup();
  }
});

test('external mode permits only lockable helper descendants of the selected Ollama root', async () => {
  const warm = [
    AMBIENT_PLAYWRIGHT,
    AUTHORIZED_EXTERNAL_OLLAMA,
    AUTHORIZED_EXTERNAL_HELPER,
  ] as const;
  const idle = [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA] as const;
  const cases = [
    [warm, warm, warm, warm],
    [idle, idle, idle, warm],
  ] as const;

  for (const snapshots of cases) {
    const scenario = await runHarnessScenario({
      preexistingSnapshots: snapshots.map((ambientProcesses) => ({
        ambientProcesses,
      })),
      processStates: ['present', 'present'],
    });
    try {
      assert.equal(scenario.result.status, 'passed');
      assert.equal(scenario.result.baselinePreserved, true);
      assert.deepEqual(
        scenario.harness.requests.map((request) => request.kind),
        ['canonical'],
      );
      assert.equal(
        scenario.harness.trace.includes('terminate:baseline'),
        false,
      );
    } finally {
      await scenario.cleanup();
    }
  }
});

test('an external Ollama appearing in the commit snapshot wins over an unrelated occupied controlled port', async () => {
  const scenario = await runHarnessScenario({
    preexistingSnapshots: [
      {
        ambientProcesses: [AMBIENT_PLAYWRIGHT],
        preoccupiedPort: true,
      },
      {
        ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
        preoccupiedPort: true,
      },
    ],
    processStates: ['present', 'present'],
  });
  try {
    assert.equal(scenario.result.status, 'passed');
    assert.equal(scenario.result.baselinePreserved, true);
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['canonical'],
    );
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
  } finally {
    await scenario.cleanup();
  }
});

test('an initial external identity disappearing before mode commit is red without controlled fallback', async () => {
  const scenario = await runHarnessScenario({
    preexistingSnapshots: [
      {
        ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
      },
      { ambientProcesses: [AMBIENT_PLAYWRIGHT] },
    ],
  });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_root_lost_before_canonical',
      projectionVerified: false,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.equal(scenario.harness.requests.length, 0);
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
  } finally {
    await scenario.cleanup();
  }
});

test('a committed external identity drifting before canonical is red without fallback or termination', async () => {
  const scenario = await runHarnessScenario({
    preexistingSnapshots: [
      {
        ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
      },
      {
        ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
      },
      {
        ambientProcesses: [
          AMBIENT_PLAYWRIGHT,
          REUSED_AUTHORIZED_EXTERNAL_OLLAMA,
        ],
      },
    ],
    processStates: ['present'],
  });
  try {
    assert.equal(
      scenario.result.failureCode,
      'baseline_root_lost_before_canonical',
    );
    assert.equal(scenario.result.projectionVerified, true);
    assert.equal(scenario.result.canonicalStarted, false);
    assert.equal(scenario.result.cleanupComplete, true);
    assert.equal(scenario.harness.requests.length, 0);
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
    await assert.rejects(lstat(scenario.fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await scenario.cleanup();
  }
});

test('an unavailable selected external identity probe is red before canonical without fallback', async () => {
  const scenario = await runHarnessScenario({
    ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
    processStates: ['unknown'],
  });
  try {
    assert.equal(
      scenario.result.failureCode,
      'baseline_root_lost_before_canonical',
    );
    assert.equal(scenario.result.projectionVerified, true);
    assert.equal(scenario.result.canonicalStarted, false);
    assert.equal(scenario.result.cleanupComplete, true);
    assert.equal(scenario.harness.requests.length, 0);
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
  } finally {
    await scenario.cleanup();
  }
});

test('a committed external identity drifting after canonical is not replaced by another Ollama', async () => {
  const scenario = await runHarnessScenario({
    preexistingSnapshots: [
      {
        ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
      },
      {
        ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
      },
      {
        ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
      },
      {
        ambientProcesses: [
          AMBIENT_PLAYWRIGHT,
          REPLACEMENT_AUTHORIZED_EXTERNAL_OLLAMA,
        ],
      },
    ],
    processStates: ['present', 'present'],
  });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_not_preserved_after_canonical',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: true,
    });
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['canonical'],
    );
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
  } finally {
    await scenario.cleanup();
  }
});

test('controlled mode turns red when an external Ollama appears after its mode commit and cleans only the owned child', async () => {
  const scenario = await runHarnessScenario({
    ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
    preexistingSnapshots: [
      { ambientProcesses: [AMBIENT_PLAYWRIGHT] },
      { ambientProcesses: [AMBIENT_PLAYWRIGHT] },
    ],
  });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'ambient_baseline_process_present',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: true,
      canonicalStarted: false,
    });
    assert.deepEqual(
      scenario.harness.requests.map((request) => request.kind),
      ['baseline'],
    );
    assert.equal(
      scenario.harness.trace.filter((entry) => entry === 'terminate:baseline').length,
      1,
    );
    assert.equal(
      scenario.harness.probedIdentities.some((identity) =>
        identityMatches(identity, AUTHORIZED_EXTERNAL_OLLAMA)
      ),
      false,
    );
  } finally {
    await scenario.cleanup();
  }
});

test('controlled readiness rejects a foreign Ollama before the owned root is first observed', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  let firstReadinessSnapshot = true;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    snapshot: async () => {
      const scope = await harness.adapter.snapshot();
      if (
        !harness.requests.some((request) => request.kind === 'baseline') ||
        !firstReadinessSnapshot
      ) {
        return scope;
      }
      firstReadinessSnapshot = false;
      return {
        processes: [
          ROOT_PROCESS,
          AMBIENT_PLAYWRIGHT,
          AUTHORIZED_EXTERNAL_OLLAMA,
        ],
        listeners: [],
      };
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.equal(result.failureCode, 'ambient_baseline_process_present');
    assert.equal(result.canonicalStarted, false);
    assert.equal(result.cleanupComplete, false);
    assert.equal(harness.trace.includes('terminate:baseline'), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('controlled readiness confirmation rejects a transient foreign Ollama', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  let confirmationInjected = false;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    snapshot: async () => {
      const scope = await harness.adapter.snapshot();
      if (
        confirmationInjected ||
        !harness.trace.some((entry) => entry.startsWith('http:'))
      ) {
        return scope;
      }
      confirmationInjected = true;
      return {
        ...scope,
        processes: [...scope.processes, AUTHORIZED_EXTERNAL_OLLAMA],
      };
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.equal(result.failureCode, 'ambient_baseline_process_present');
    assert.equal(result.canonicalStarted, false);
    assert.equal(result.cleanupComplete, true);
    assert.equal(
      harness.trace.filter((entry) => entry === 'terminate:baseline').length,
      1,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('controlled mode records an external Ollama first observed during cleanup as topology red', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  let cleanPostCanonicalSnapshotSeen = false;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    snapshot: async () => {
      const scope = await harness.adapter.snapshot();
      if (!harness.trace.includes('canonical:exit')) return scope;
      if (!cleanPostCanonicalSnapshotSeen) {
        cleanPostCanonicalSnapshotSeen = true;
        return scope;
      }
      return {
        ...scope,
        processes: [...scope.processes, AUTHORIZED_EXTERNAL_OLLAMA],
      };
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      failureCode: 'ambient_baseline_process_present',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: true,
      canonicalStarted: true,
    });
    assert.equal(
      harness.trace.filter((entry) => entry === 'terminate:baseline').length,
      1,
    );
    assert.equal(
      harness.probedIdentities.some((identity) =>
        identityMatches(identity, AUTHORIZED_EXTERNAL_OLLAMA)
      ),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cleanup treats a reused controlled root PID as a foreign exact identity', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  let canonicalExited = false;
  let cleanPostCanonicalSnapshotSeen = false;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    spawnChild: async (request) => {
      const child = await harness.adapter.spawnChild(request);
      if (request.kind === 'baseline') {
        return {
          get pid() {
            return child.pid;
          },
          get exitCode() {
            return canonicalExited ? 0 : child.exitCode;
          },
          get signalCode() {
            return child.signalCode;
          },
          waitForExit: () => child.waitForExit(),
        };
      }
      return {
        ...child,
        waitForExit: async () => {
          const exitCode = await child.waitForExit();
          canonicalExited = true;
          return exitCode;
        },
      };
    },
    snapshot: async () => {
      const scope = await harness.adapter.snapshot();
      if (!canonicalExited) return scope;
      if (!cleanPostCanonicalSnapshotSeen) {
        cleanPostCanonicalSnapshotSeen = true;
        return scope;
      }
      return {
        processes: [ROOT_PROCESS, AMBIENT_PLAYWRIGHT, REUSED_CONTROLLED_ROOT],
        listeners: [],
      };
    },
    processState: async (identity) => {
      if (
        cleanPostCanonicalSnapshotSeen &&
        [BASELINE_PROCESS, BASELINE_HELPER].some((expected) =>
          identityMatches(identity, expected)
        )
      ) {
        return 'absent';
      }
      return harness.adapter.processState(identity);
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      failureCode: 'ambient_baseline_process_present',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: true,
      canonicalStarted: true,
    });
    assert.equal(harness.trace.includes('terminate:baseline'), false);
    await assert.rejects(lstat(fixture.ownedRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('ambiguous exact Ollama roots, ambient helpers, and ambient runtimes stay forbidden', async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly processes: readonly AcceptanceScopeProcessObservation[];
  }> = [
    {
      name: 'ambiguous exact roots',
      processes: [
        AMBIENT_PLAYWRIGHT,
        AUTHORIZED_EXTERNAL_OLLAMA,
        REPLACEMENT_AUTHORIZED_EXTERNAL_OLLAMA,
      ],
    },
    {
      name: 'ambient helper',
      processes: [AMBIENT_PLAYWRIGHT, BASELINE_HELPER],
    },
    {
      name: 'ambient runtime',
      processes: [AMBIENT_PLAYWRIGHT, AMBIENT_CAPTURE_RUNTIME],
    },
    {
      name: 'coordinator descendant',
      processes: [
        AMBIENT_PLAYWRIGHT,
        { ...AUTHORIZED_EXTERNAL_OLLAMA, parentPid: ROOT_PROCESS.pid },
      ],
    },
  ];
  for (const item of cases) {
    const scenario = await runHarnessScenario({
      ambientProcesses: item.processes,
    });
    try {
      assert.equal(
        scenario.result.failureCode,
        'ambient_baseline_process_present',
        item.name,
      );
      assert.equal(scenario.result.canonicalStarted, false, item.name);
      assert.equal(scenario.harness.requests.length, 0, item.name);
      assert.equal(
        scenario.harness.trace.includes('terminate:baseline'),
        false,
        item.name,
      );
    } finally {
      await scenario.cleanup();
    }
  }
});

test('a wrong-path external same-name Ollama remains ambient red', async () => {
  const scenario = await runHarnessScenario({
    ambientProcesses: [AMBIENT_PLAYWRIGHT, EXTERNAL_OLLAMA],
  });
  try {
    assert.equal(scenario.result.failureCode, 'ambient_baseline_process_present');
    assert.equal(scenario.result.canonicalStarted, false);
    assert.equal(scenario.harness.requests.length, 0);
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
  } finally {
    await scenario.cleanup();
  }
});

test('external mode reports owned-root cleanup failure independently and never terminates the external process', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort, {
    ambientProcesses: [AMBIENT_PLAYWRIGHT, AUTHORIZED_EXTERNAL_OLLAMA],
    processStates: ['present', 'present'],
  });
  let ownedRootRemoved = false;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    files: {
      ...harness.adapter.files,
      lstat: async (path) => {
        const metadata = await lstat(path);
        if (
          path !== fixture.ownedRoot ||
          !harness.trace.includes('canonical:exit')
        ) {
          return metadata;
        }
        return {
          size: metadata.size,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      },
      rm: async (path, options) => {
        if (path === fixture.ownedRoot) ownedRootRemoved = true;
        await rm(path, options);
      },
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: false,
      cleanupFailureCode: 'owned_root_cleanup_failed',
      canonicalStarted: true,
    });
    assert.equal(ownedRootRemoved, false);
    assert.equal(harness.trace.includes('terminate:baseline'), false);
    assert.equal((await lstat(fixture.ownedRoot)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a PID identity mismatch at cleanup is never terminated and keeps the owned root gated', async () => {
  const scenario = await runHarnessScenario({
    // The third identity probe represents the same PID observed with a
    // different creation time or executable after canonical returns.
    processStates: ['present', 'present', 'absent'],
  });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: false,
      cleanupFailureCode: 'baseline_cleanup_failed',
      canonicalStarted: true,
    });
    assert.equal(scenario.harness.trace.includes('terminate:baseline'), false);
    assert.equal((await lstat(scenario.fixture.ownedRoot)).isDirectory(), true);
  } finally {
    await scenario.cleanup();
  }
});

test('a recorded helper descendant that survives exact root termination keeps cleanup red', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    processState: async (identity) => {
      if (
        harness.trace.includes('terminate:baseline') &&
        identityMatches(identity, BASELINE_HELPER)
      ) {
        return 'present';
      }
      return harness.adapter.processState(identity);
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: false,
      cleanupFailureCode: 'baseline_cleanup_failed',
      canonicalStarted: true,
    });
    assert.equal((await lstat(fixture.ownedRoot)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cleanup stays red when the immutable baseline port remains bound after identities disappear', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    snapshot: async () => {
      const scope = await harness.adapter.snapshot();
      if (!harness.trace.includes('terminate:baseline')) return scope;
      return {
        ...scope,
        listeners: [{
          host: '127.0.0.1',
          port: input.baselinePort,
          protocol: 'tcp',
          owningPid: BASELINE_HELPER.pid,
        }],
      };
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.equal(result.cleanupFailureCode, 'baseline_cleanup_failed');
    assert.equal(result.cleanupComplete, false);
    assert.equal((await lstat(fixture.ownedRoot)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a terminal absent root still requires every recorded helper descendant to be absent', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort, {
    processStates: ['present', 'present', 'absent', 'present'],
  });
  let canonicalExited = false;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    spawnChild: async (request) => {
      const child = await harness.adapter.spawnChild(request);
      if (request.kind === 'baseline') {
        return {
          get pid() {
            return child.pid;
          },
          get exitCode() {
            return canonicalExited ? 0 : child.exitCode;
          },
          get signalCode() {
            return child.signalCode;
          },
          waitForExit: () => child.waitForExit(),
        };
      }
      return {
        get pid() {
          return child.pid;
        },
        get exitCode() {
          return child.exitCode;
        },
        get signalCode() {
          return child.signalCode;
        },
        waitForExit: async () => {
          const code = await child.waitForExit();
          canonicalExited = true;
          return code;
        },
      };
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.equal(result.baselinePreserved, true);
    assert.equal(result.cleanupFailureCode, 'baseline_cleanup_failed');
    assert.equal(result.cleanupComplete, false);
    assert.equal(harness.trace.includes('terminate:baseline'), false);
    assert.equal((await lstat(fixture.ownedRoot)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a reused child PID seen before root identity capture is never adopted or terminated', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  const reused = {
    ...BASELINE_PROCESS,
    parentPid: 8999,
    creationTimeUtc: '2026-09-01T00:09:00.000Z',
  };
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    processState: async () => 'present',
    snapshot: async () => {
      if (!harness.requests.some((request) => request.kind === 'baseline')) {
        return {
          processes: [ROOT_PROCESS, AMBIENT_PLAYWRIGHT],
          listeners: [],
        };
      }
      return {
        processes: [ROOT_PROCESS, reused, AMBIENT_PLAYWRIGHT],
        listeners: [{
          host: '127.0.0.1',
          port: input.baselinePort,
          protocol: 'tcp',
          owningPid: reused.pid,
        }],
      };
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.equal(result.failureCode, 'baseline_root_exited_before_ready');
    assert.equal(result.cleanupFailureCode, 'baseline_cleanup_failed');
    assert.equal(result.cleanupComplete, false);
    assert.equal(harness.trace.includes('terminate:baseline'), false);
    assert.equal((await lstat(fixture.ownedRoot)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cleanup failure preserves the primary verdict, does not remove model data, and leaks no private canary', async () => {
  const scenario = await runHarnessScenario({
    listenerOwnerPid: AMBIENT_PLAYWRIGHT.pid,
    terminateFailure: true,
  });
  try {
    assert.deepEqual(scenario.result, {
      status: 'failed',
      failureCode: 'baseline_port_collision',
      projectionVerified: true,
      baselinePreserved: false,
      cleanupComplete: false,
      cleanupFailureCode: 'baseline_cleanup_failed',
      canonicalStarted: false,
    });
    assert.equal((await lstat(scenario.fixture.ownedRoot)).isDirectory(), true);
    const serialized = JSON.stringify(scenario.result);
    assert.doesNotMatch(serialized, /private termination canary|capture-j53-coordinator/iu);
  } finally {
    await scenario.cleanup();
  }
});

test('owned-root cleanup refuses a reparse observation instead of recursively deleting it', async () => {
  const fixture = await createFixture();
  const input = inputFor(fixture);
  const harness = createHarness(input.baselinePort);
  let cleanupPhase = false;
  let ownedRootRemoved = false;
  const adapter: RealJpegAcceptanceAdapter = {
    ...harness.adapter,
    files: {
      ...harness.adapter.files,
      lstat: async (path) => {
        const metadata = await lstat(path);
        if (!cleanupPhase || path !== fixture.ownedRoot) return metadata;
        return {
          size: metadata.size,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      },
      rm: async (path, options) => {
        if (path === fixture.ownedRoot) ownedRootRemoved = true;
        await rm(path, options);
      },
    },
    terminateTrackedProcessTree: async (child) => {
      await harness.adapter.terminateTrackedProcessTree(child);
      cleanupPhase = true;
    },
  };
  try {
    const result = await runRealJpegAcceptance(input, adapter);

    assert.deepEqual(result, {
      status: 'failed',
      canonicalExitCode: 0,
      projectionVerified: true,
      baselinePreserved: true,
      cleanupComplete: false,
      cleanupFailureCode: 'owned_root_cleanup_failed',
      canonicalStarted: true,
    });
    assert.equal(ownedRootRemoved, false);
    assert.equal((await lstat(fixture.ownedRoot)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
