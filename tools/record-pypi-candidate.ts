import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { computeCandidateId } from './verify-release-candidate.ts';

const PROJECTS = ['capture-runtime-client'] as const;
const SHA256 = /^[0-9a-f]{64}$/u;
type JsonRecord = Record<string, unknown>;
type Artifact = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type PypiCandidateInput = {
  readonly candidate: string;
  readonly pythonDirectory: string;
  readonly candidateKind: 'package' | 'runtime' | 'full-release';
  readonly version: string;
  readonly sourceCommit: string;
  readonly candidateId: string;
  readonly releaseCandidateId: string;
  readonly packageCandidateId: string;
  readonly candidateManifestSha256: string;
  readonly sourceCandidateManifestSha256: string;
  readonly contractSetSha256: string;
};

export function parseProjects(value = PROJECTS.join(',')): readonly string[] {
  const projects = value
    .split(',')
    .map((project) => project.trim())
    .filter(Boolean);
  if (
    projects.length === 0 ||
    projects.some(
      (project) => !(PROJECTS as readonly string[]).includes(project),
    ) ||
    new Set(projects).size !== projects.length
  ) {
    throw new Error(
      `PyPI project selection is invalid: ${projects.join(',')}.`,
    );
  }
  return projects;
}

export function projectArtifacts(
  artifacts: readonly string[],
  project: string,
): readonly string[] {
  return artifacts.filter((artifact) =>
    artifact.startsWith(`${project.replaceAll('-', '_')}-`),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateInput(input: PypiCandidateInput): void {
  assert(
    ['package', 'runtime', 'full-release'].includes(input.candidateKind),
    'PyPI candidate kind is invalid.',
  );
  assert(
    typeof input.candidate === 'string' && input.candidate.length > 0,
    'Candidate directory is required.',
  );
  assert(
    typeof input.pythonDirectory === 'string' &&
      input.pythonDirectory.length > 0,
    'Python staging directory is required.',
  );
  assert(
    typeof input.version === 'string' &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.version),
    'Release version is invalid.',
  );
  assert(
    typeof input.sourceCommit === 'string' &&
      /^[0-9a-f]{40}$/u.test(input.sourceCommit),
    'Source commit is invalid.',
  );
  for (const name of [
    'candidateId',
    'releaseCandidateId',
    'packageCandidateId',
    'candidateManifestSha256',
    'sourceCandidateManifestSha256',
    'contractSetSha256',
  ] as const) {
    assert(
      typeof input[name] === 'string' && SHA256.test(input[name]),
      `PyPI ${name} is invalid or missing.`,
    );
  }
  if (input.candidateKind !== 'full-release') {
    assert.equal(
      input.candidateId,
      input.releaseCandidateId,
      'Standalone release candidate ID differs.',
    );
    assert.equal(
      input.candidateManifestSha256,
      input.sourceCandidateManifestSha256,
      'Standalone source manifest digest differs.',
    );
  }
  if (input.candidateKind === 'package')
    assert.equal(
      input.packageCandidateId,
      input.candidateId,
      'Package candidate ID differs.',
    );
}

async function regularFile(path: string): Promise<Buffer> {
  assert(
    (await lstat(path)).isFile(),
    'Candidate input must be a regular file.',
  );
  return readFile(path);
}

async function readManifest(
  path: string,
  expectedDigest: string,
  expectedId: string,
  input: PypiCandidateInput,
  kind: PypiCandidateInput['candidateKind'],
): Promise<JsonRecord> {
  const bytes = await regularFile(path);
  assert.equal(
    digest(bytes),
    expectedDigest,
    'Candidate manifest digest differs.',
  );
  const manifest: unknown = JSON.parse(bytes.toString('utf8'));
  assert(isRecord(manifest), 'Candidate manifest must be an object.');
  const common = [
    'schemaVersion',
    'sourceCommit',
    'releaseVersion',
    'contractSetSha256',
    'artifacts',
    'toolchains',
    'candidateId',
  ];
  const fields =
    kind === 'package'
      ? [...common, 'candidateKind', 'producerRunId', 'packageManifestSha256']
      : kind === 'runtime'
        ? [
            ...common,
            'candidateKind',
            'producerRunId',
            'packageCandidateId',
            'releaseMode',
          ]
        : [
            ...common,
            'releaseMode',
            'runtimeApiVersion',
            'documentSchemaVersion',
            'contractImpact',
            'packageCandidateId',
            'runtimeCandidateId',
          ];
  assert.deepEqual(
    Object.keys(manifest).sort(),
    fields.sort(),
    'Candidate manifest fields differ from the selected layout.',
  );
  assert.equal(
    manifest.schemaVersion,
    '1',
    'Candidate schema version differs.',
  );
  assert.equal(manifest.candidateId, expectedId, 'Candidate ID differs.');
  assert.equal(
    manifest.sourceCommit,
    input.sourceCommit,
    'Candidate source commit differs.',
  );
  assert.equal(
    manifest.releaseVersion,
    input.version,
    'Candidate release version differs.',
  );
  assert.equal(
    manifest.contractSetSha256,
    input.contractSetSha256,
    'Candidate contract hash differs.',
  );
  const base = { ...manifest };
  delete base.candidateId;
  assert.equal(
    computeCandidateId(base),
    expectedId,
    'Candidate ID is not bound to manifest contents.',
  );
  assert(isRecord(manifest.toolchains), 'Candidate toolchains are invalid.');
  if (kind !== 'full-release') {
    assert.equal(
      manifest.candidateKind,
      kind === 'package' ? 'npm-package-set' : 'runtime',
      'Candidate kind differs.',
    );
    assert(
      Number.isSafeInteger(manifest.producerRunId) &&
        Number(manifest.producerRunId) > 0,
      'Candidate producer run is invalid.',
    );
  }
  if (kind === 'package') {
    assert(
      typeof manifest.packageManifestSha256 === 'string' &&
        SHA256.test(manifest.packageManifestSha256),
      'Package manifest digest is invalid.',
    );
  } else {
    assert.equal(
      manifest.packageCandidateId,
      input.packageCandidateId,
      'Candidate package reference differs.',
    );
    assert(
      ['core-only', 'model-enabled'].includes(String(manifest.releaseMode)),
      'Candidate release mode is invalid.',
    );
  }
  if (kind === 'full-release') {
    assert.equal(
      manifest.runtimeCandidateId,
      input.candidateId,
      'Full release runtime reference differs.',
    );
    assert.equal(manifest.runtimeApiVersion, '2.0');
    assert.equal(manifest.documentSchemaVersion, '2');
  }
  return manifest;
}

function inventory(manifest: JsonRecord): Map<string, Artifact> {
  assert(
    Array.isArray(manifest.artifacts),
    'Candidate artifact inventory is invalid.',
  );
  const records = new Map<string, Artifact>();
  const seen = new Set<string>();
  for (const item of manifest.artifacts) {
    assert(isRecord(item), 'Candidate artifact is invalid.');
    assert.deepEqual(
      Object.keys(item).sort(),
      ['bytes', 'path', 'sha256'],
      'Candidate artifact fields are invalid.',
    );
    assert(
      typeof item.path === 'string' &&
        /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(item.path) &&
        item.path.split('/').every((part) => part !== '.' && part !== '..'),
      'Candidate artifact path is not canonical.',
    );
    assert(
      !seen.has(item.path.toLowerCase()),
      'Candidate artifact inventory contains duplicate paths.',
    );
    assert(
      Number.isSafeInteger(item.bytes) && Number(item.bytes) >= 0,
      'Candidate artifact size is invalid.',
    );
    assert(
      typeof item.sha256 === 'string' && SHA256.test(item.sha256),
      'Candidate artifact digest is invalid.',
    );
    seen.add(item.path.toLowerCase());
    records.set(item.path, item as Artifact);
  }
  return records;
}

async function validateCandidate(input: PypiCandidateInput) {
  validateInput(input);
  assert(
    (await lstat(input.candidate)).isDirectory(),
    'Candidate must be a regular directory.',
  );
  const main = await readManifest(
    join(input.candidate, 'candidate-manifest.json'),
    input.candidateManifestSha256,
    input.releaseCandidateId,
    input,
    input.candidateKind,
  );
  const mainInventory = inventory(main);
  let sourceInventory = mainInventory;
  if (input.candidateKind === 'full-release') {
    const runtime = await readManifest(
      join(input.candidate, 'runtime-candidate-manifest.json'),
      input.sourceCandidateManifestSha256,
      input.candidateId,
      input,
      'runtime',
    );
    assert.equal(
      main.releaseMode,
      runtime.releaseMode,
      'Full release and runtime modes differ.',
    );
    sourceInventory = inventory(runtime);
    for (const [path, item] of sourceInventory)
      assert.deepEqual(
        mainInventory.get(path),
        item,
        'Full release runtime inventory differs.',
      );
  } else {
    assert(
      !(await readdir(input.candidate)).includes(
        'runtime-candidate-manifest.json',
      ),
      'Standalone candidate has an ambiguous runtime alias.',
    );
  }
  const python = [...sourceInventory.values()]
    .filter((item) => item.path.startsWith('python/'))
    .sort((a, b) => a.path.localeCompare(b.path));
  const mainPython = [...mainInventory.values()]
    .filter((item) => item.path.startsWith('python/'))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    mainPython,
    python,
    'Full release Python inventory differs.',
  );
  const escapedVersion = input.version.replaceAll('.', '\\.');
  const wheel = new RegExp(
    `^python/capture_runtime_client-${escapedVersion}-(?:[0-9][A-Za-z0-9_]*-)?[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\\.whl$`,
    'u',
  );
  assert(
    python.length === 2 &&
      python.filter((item) => wheel.test(item.path)).length === 1 &&
      python.filter(
        (item) =>
          item.path === `python/capture_runtime_client-${input.version}.tar.gz`,
      ).length === 1,
    'PyPI inventory must contain exactly one version-matched wheel and sdist.',
  );
  const names = python.map((item) => item.path.slice('python/'.length)).sort();
  for (const directory of [
    join(input.candidate, 'python'),
    input.pythonDirectory,
  ]) {
    assert(
      (await lstat(directory)).isDirectory(),
      'Python artifacts must use a regular directory.',
    );
    assert.deepEqual(
      (await readdir(directory)).sort(),
      names,
      'Python directory contains missing or extra artifacts.',
    );
    for (const item of python) {
      const bytes = await regularFile(
        join(directory, item.path.slice('python/'.length)),
      );
      assert.equal(
        bytes.length,
        item.bytes,
        'Python artifact size differs from the candidate.',
      );
      assert.equal(
        digest(bytes),
        item.sha256,
        'Python artifact digest differs from the candidate.',
      );
    }
  }
  return {
    schemaVersion: '1',
    candidateKind: input.candidateKind,
    candidateId: input.candidateId,
    releaseCandidateId: input.releaseCandidateId,
    packageCandidateId: input.packageCandidateId,
    sourceCommit: input.sourceCommit,
    releaseVersion: input.version,
    contractSetSha256: input.contractSetSha256,
    candidateManifestSha256: input.candidateManifestSha256,
    sourceCandidateManifestSha256: input.sourceCandidateManifestSha256,
    artifacts: python.map((item) => ({
      name: item.path.slice('python/'.length),
      bytes: item.bytes,
      sha256: item.sha256,
    })),
  };
}

export type PypiPreflightBinding = Awaited<
  ReturnType<typeof validateCandidate>
>;

async function reconcile(
  binding: PypiPreflightBinding,
  preflight: boolean,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  const version = binding.releaseVersion;
  for (const project of PROJECTS) {
    const response = await fetch(
      `https://pypi.org/pypi/${project}/${version}/json`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gx-capture-release-verifier',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (preflight && response.status === 404) continue;
    assert(
      response.status === 200,
      `PyPI metadata is unavailable (HTTP ${response.status}).`,
    );
    const payload: unknown = await response.json();
    assert(
      isRecord(payload) &&
        isRecord(payload.info) &&
        payload.info.name === project &&
        payload.info.version === version &&
        Array.isArray(payload.urls) &&
        payload.urls.length > 0,
      'PyPI metadata is malformed or has a different identity.',
    );
    const expected = new Map(
      binding.artifacts.map((item) => [item.name, item.sha256]),
    );
    const remote = new Set<string>();
    for (const item of payload.urls) {
      assert(
        isRecord(item) &&
          typeof item.filename === 'string' &&
          isRecord(item.digests) &&
          typeof item.digests.sha256 === 'string' &&
          SHA256.test(item.digests.sha256),
        'PyPI distribution metadata is malformed.',
      );
      assert(
        !remote.has(item.filename),
        'PyPI metadata contains duplicate filenames.',
      );
      assert(
        expected.has(item.filename),
        'PyPI contains an extra distribution.',
      );
      assert.equal(
        item.digests.sha256,
        expected.get(item.filename),
        'PyPI distribution conflicts with the candidate.',
      );
      remote.add(item.filename);
    }
    if (!preflight)
      assert.equal(remote.size, expected.size, 'PyPI readback is incomplete.');
  }
}

export async function preflightPypiCandidate(
  input: PypiCandidateInput,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<PypiPreflightBinding> {
  const binding = await validateCandidate(input);
  await reconcile(binding, true, fetch);
  assert.deepEqual(
    await validateCandidate(input),
    binding,
    'Candidate changed during PyPI preflight.',
  );
  return binding;
}

export async function recordPypiCandidate(
  input: PypiCandidateInput,
  savedBinding: unknown,
  fetch: typeof globalThis.fetch = globalThis.fetch,
) {
  const binding = await validateCandidate(input);
  assert.deepEqual(
    savedBinding,
    binding,
    'PyPI preflight binding differs from the current candidate.',
  );
  await reconcile(binding, false, fetch);
  assert.deepEqual(
    await validateCandidate(input),
    binding,
    'Candidate changed during PyPI readback.',
  );
  return {
    schemaVersion: '1',
    registry: 'pypi',
    candidateId: binding.candidateId,
    releaseCandidateId: binding.releaseCandidateId,
    contractSetSha256: binding.contractSetSha256,
    sourceCandidateManifestSha256: binding.sourceCandidateManifestSha256,
    releaseVersion: binding.releaseVersion,
    status: 'published',
    artifacts: binding.artifacts.map(({ name, sha256 }) => ({ name, sha256 })),
  };
}

async function main(): Promise<void> {
  const values = new Map<string, string>();
  const fields = [
    'candidate',
    'python-directory',
    'candidate-kind',
    'version',
    'source-commit',
    'candidate-id',
    'release-candidate-id',
    'package-candidate-id',
    'candidate-manifest-sha256',
    'source-candidate-manifest-sha256',
    'contract-set-sha256',
  ] as const;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/u, '');
    const value = args[index + 1];
    assert(
      args[index]?.startsWith('--') &&
        [...fields, 'mode', 'binding', 'output', 'projects'].includes(name) &&
        value &&
        !values.has(name),
      'PyPI CLI arguments are invalid or duplicated.',
    );
    values.set(name, value);
  }
  const mode = values.get('mode');
  assert(
    mode === 'preflight' || mode === 'record',
    'Explicit --mode preflight or record is required.',
  );
  for (const name of [
    ...fields,
    'binding',
    ...(mode === 'record' ? ['output'] : []),
  ])
    assert(values.has(name), `Missing required --${name}.`);
  assert(
    mode === 'record' || !values.has('output'),
    'Preflight writes only --binding, not a ledger output.',
  );
  parseProjects(values.get('projects'));
  const required = (name: string): string => {
    const value = values.get(name);
    assert(value, `Missing required --${name}.`);
    return value;
  };
  const input = Object.fromEntries(
    fields.map((field) => [
      field.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      required(field),
    ]),
  ) as PypiCandidateInput;
  const bindingPath = resolve(required('binding'));
  if (mode === 'preflight') {
    const binding = await preflightPypiCandidate(input);
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, {
      flag: 'wx',
    });
  } else {
    const ledger = await recordPypiCandidate(
      input,
      JSON.parse(
        await regularFile(bindingPath).then((bytes) => bytes.toString('utf8')),
      ),
    );
    await writeFile(
      resolve(required('output')),
      `${JSON.stringify(ledger, null, 2)}\n`,
      { flag: 'wx' },
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
