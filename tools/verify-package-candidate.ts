import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAMES = new Map([
  ['gx-capture-capture-workbench', '@gx-capture/capture-workbench'],
  ['gx-capture-capture-contracts', '@gx-capture/capture-contracts'],
  ['gx-capture-capture-structuring', '@gx-capture/capture-structuring'],
]);

type JsonRecord = Record<string, unknown>;

export type PackageCandidateVerification = {
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly sourceCommit: string;
  readonly releaseVersion: string;
  readonly producerRunId: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} fields are not canonical.`,
  );
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function sha512Integrity(path: string): Promise<string> {
  return `sha512-${createHash('sha512')
    .update(await readFile(path))
    .digest('base64')}`;
}

function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  let requireEvidence = false;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (name === '--require-evidence') {
      if (index !== args.length - 1)
        throw new Error('Use --require-evidence without a value.');
      requireEvidence = true;
      continue;
    }
    const value = args[index + 1];
    if (
      ![
        '--candidate',
        '--version',
        '--source-commit',
        '--producer-run-id',
        '--candidate-id',
        '--candidate-manifest-sha256',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --candidate <directory> --version <semver> --source-commit <sha> --producer-run-id <id> --candidate-id <sha> --candidate-manifest-sha256 <sha> [--require-evidence].',
      );
    }
    values.set(name, value);
  }
  const required = [
    '--candidate',
    '--version',
    '--source-commit',
    '--producer-run-id',
    '--candidate-id',
    '--candidate-manifest-sha256',
  ];
  if (required.some((name) => !values.has(name))) {
    throw new Error(
      'Use --candidate <directory> --version <semver> --source-commit <sha> --producer-run-id <id> --candidate-id <sha> --candidate-manifest-sha256 <sha> [--require-evidence].',
    );
  }
  const producerRunId = Number(values.get('--producer-run-id'));
  const version = values.get('--version')!;
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    !/^[0-9a-f]{40}$/u.test(values.get('--source-commit')!) ||
    !/^[0-9a-f]{64}$/u.test(values.get('--candidate-id')!) ||
    !/^[0-9a-f]{64}$/u.test(values.get('--candidate-manifest-sha256')!) ||
    !Number.isSafeInteger(producerRunId) ||
    producerRunId < 1
  ) {
    throw new Error('Package candidate identity arguments are invalid.');
  }
  return {
    candidate: resolve(values.get('--candidate')!),
    version,
    sourceCommit: values.get('--source-commit')!,
    producerRunId,
    candidateId: values.get('--candidate-id')!,
    candidateManifestSha256: values.get('--candidate-manifest-sha256')!,
    requireEvidence,
  };
}

export async function verifyPackageCandidate(input: {
  readonly candidate: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly producerRunId: number;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly requireEvidence?: boolean;
}): Promise<PackageCandidateVerification> {
  const manifestPath = join(input.candidate, 'candidate-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifestDigest = createHash('sha256')
    .update(manifestBytes)
    .digest('hex');
  assert.equal(
    manifestDigest,
    input.candidateManifestSha256,
    'Candidate manifest digest differs.',
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  assert(isRecord(manifest), 'Package candidate manifest must be an object.');
  exactKeys(
    manifest,
    [
      'artifacts',
      'candidateId',
      'candidateKind',
      'packageManifestSha256',
      'producerRunId',
      'releaseVersion',
      'schemaVersion',
      'sourceCommit',
      'toolchains',
    ],
    'Package candidate manifest',
  );
  assert.equal(manifest.candidateKind, 'npm-package-set');
  assert.equal(manifest.schemaVersion, '1');
  assert.equal(manifest.candidateId, input.candidateId);
  assert.equal(manifest.sourceCommit, input.sourceCommit);
  assert.equal(manifest.releaseVersion, input.version);
  assert.equal(manifest.producerRunId, input.producerRunId);
  assert.match(String(manifest.packageManifestSha256), /^[0-9a-f]{64}$/u);
  assert(
    Array.isArray(manifest.artifacts),
    'Package candidate artifacts must be an array.',
  );

  const baseManifest = { ...manifest } as JsonRecord;
  delete baseManifest.candidateId;
  const expectedCandidateId = createHash('sha256')
    .update(JSON.stringify(baseManifest))
    .digest('hex');
  assert.equal(
    expectedCandidateId,
    input.candidateId,
    'Package candidate ID is not bound to its manifest.',
  );

  const packageManifestPath = join(input.candidate, 'package-manifest.json');
  const packageManifestBytes = await readFile(packageManifestPath);
  assert.equal(
    createHash('sha256').update(packageManifestBytes).digest('hex'),
    manifest.packageManifestSha256,
    'Package manifest digest differs from the candidate manifest.',
  );
  const packageManifest = JSON.parse(
    packageManifestBytes.toString('utf8'),
  ) as unknown;
  assert(isRecord(packageManifest), 'Package manifest must be an object.');
  exactKeys(
    packageManifest,
    ['candidateKind', 'packages', 'releaseVersion', 'schemaVersion'],
    'Package manifest',
  );
  assert.equal(packageManifest.candidateKind, 'npm-package-set');
  assert.equal(packageManifest.schemaVersion, '1');
  assert.equal(packageManifest.releaseVersion, input.version);
  assert(
    Array.isArray(packageManifest.packages),
    'Package manifest packages must be an array.',
  );
  assert.equal(packageManifest.packages.length, PACKAGE_NAMES.size);

  const artifactPaths = new Set<string>();
  for (const item of manifest.artifacts) {
    assert(isRecord(item), 'Package candidate artifact is invalid.');
    exactKeys(item, ['bytes', 'path', 'sha256'], 'Package candidate artifact');
    assert(
      typeof item.path === 'string' && !item.path.includes('..'),
      'Package artifact path is invalid.',
    );
    artifactPaths.add(item.path);
    const artifactPath = join(input.candidate, item.path);
    const metadata = await stat(artifactPath);
    assert(metadata.isFile(), `Package artifact is not a file: ${item.path}.`);
    assert.equal(
      metadata.size,
      item.bytes,
      `Package artifact size differs: ${item.path}.`,
    );
    assert.equal(
      await sha256(artifactPath),
      item.sha256,
      `Package artifact digest differs: ${item.path}.`,
    );
    const checksumPath = join(
      input.candidate,
      'checksums',
      `${item.path.replaceAll('/', '__')}.sha256`,
    );
    assert.equal(
      (await readFile(checksumPath, 'utf8')).trim(),
      `${item.sha256}  ${item.path}`,
      `Package artifact checksum record differs: ${item.path}.`,
    );
  }
  const expectedArtifacts = new Set([
    ...[...PACKAGE_NAMES.keys()].map(
      (name) => `package/${name}-${input.version}.tgz`,
    ),
    'package-manifest.json',
    'contracts/contract-snapshot.json',
  ]);
  assert.deepEqual(
    artifactPaths,
    expectedArtifacts,
    'Package candidate artifact inventory differs.',
  );

  const packageNames = new Set<string>();
  for (const item of packageManifest.packages) {
    assert(isRecord(item), 'Package manifest entry is invalid.');
    exactKeys(
      item,
      ['archive', 'bytes', 'integrity', 'name', 'sha256'],
      'Package manifest entry',
    );
    assert(typeof item.archive === 'string' && artifactPaths.has(item.archive));
    assert(
      typeof item.name === 'string' &&
        PACKAGE_NAMES.has(
          item.archive
            .slice('package/'.length)
            .split(`-${input.version}.tgz`)[0]!,
        ),
    );
    assert(
      !packageNames.has(item.name),
      'Package manifest contains a duplicate package.',
    );
    packageNames.add(item.name);
    const archivePath = join(input.candidate, item.archive);
    assert.equal(await sha256(archivePath), item.sha256);
    assert.equal(await sha512Integrity(archivePath), item.integrity);
    assert.equal((await stat(archivePath)).size, item.bytes);
  }
  assert.deepEqual(
    packageNames,
    new Set(PACKAGE_NAMES.values()),
    'Package manifest package set is incomplete.',
  );

  const contractSnapshot = JSON.parse(
    await readFile(
      join(input.candidate, 'contracts', 'contract-snapshot.json'),
      'utf8',
    ),
  ) as unknown;
  assert(
    isRecord(contractSnapshot) && contractSnapshot.schemaVersion === '1',
    'Contract snapshot is invalid.',
  );

  if (input.requireEvidence) {
    const evidencePath = join(
      input.candidate,
      'cross-framework-consumers.json',
    );
    const evidence = JSON.parse(
      await readFile(evidencePath, 'utf8'),
    ) as unknown;
    assert(isRecord(evidence), 'Package consumer evidence must be an object.');
    exactKeys(
      evidence,
      ['candidateId', 'schemaVersion', 'status', 'verification'],
      'Package consumer evidence',
    );
    assert.equal(evidence.schemaVersion, '1');
    assert.equal(evidence.candidateId, input.candidateId);
    assert.equal(evidence.verification, 'cross-framework-consumers');
    assert.equal(evidence.status, 'success');
  }
  return {
    candidateId: input.candidateId,
    candidateManifestSha256: input.candidateManifestSha256,
    sourceCommit: input.sourceCommit,
    releaseVersion: input.version,
    producerRunId: input.producerRunId,
  };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const verified = await verifyPackageCandidate(parsed);
  process.stdout.write(
    `Verified npm package candidate ${verified.releaseVersion} (${verified.candidateId}).\n`,
  );
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
