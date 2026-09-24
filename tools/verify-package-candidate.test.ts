import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { verifyPackageCandidate } from './verify-package-candidate.ts';
import { verifyPackageCandidateBinding } from './verify-package-candidate-binding.ts';

const version = '0.4.2';
const sourceCommit = 'a'.repeat(40);
const producerRunId = 12345;
const contractSetBytes = Buffer.from('{"catalogVersion":"2"}\n', 'utf8');
const CANONICAL_CONTRACT_SET_SHA256 =
  'd293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40';
const STALE_CONTRACT_SET_SHA256 =
  '858e258be437465821d92ec4aa33e494aca5600b672af06856a26e883af827a0';
const packages = [
  ['@gx-capture/capture-workbench-ui', 'gx-capture-capture-workbench-ui'],
  ['@gx-capture/capture-runtime-client', 'gx-capture-capture-runtime-client'],
] as const;

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function integrity(value: Buffer): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

async function makeCandidate(
  options: {
    readonly contractSetBytes?: Buffer;
    readonly runtimePackageContractSetSha256?: string;
  } = {},
): Promise<{
  root: string;
  candidateId: string;
  manifestSha256: string;
  contractSetSha256: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'capture-package-candidate-'));
  await mkdir(join(root, 'package'));
  await mkdir(join(root, 'python'));
  await mkdir(join(root, 'contracts'));
  await mkdir(join(root, 'maven'));
  await mkdir(join(root, 'checksums'));
  const candidateContractSetBytes =
    options.contractSetBytes ?? contractSetBytes;
  const contractSetSha256 = digest(candidateContractSetBytes);
  const runtimePackageContractSetSha256 =
    options.runtimePackageContractSetSha256 ?? contractSetSha256;
  const artifactValues = new Map<string, Buffer>();
  const packageEntries = [];
  for (const [name, archiveBase] of packages) {
    const archive = `package/${archiveBase}-${version}.tgz`;
    const archiveInput = join(root, 'archive-input', archiveBase);
    await mkdir(join(archiveInput, 'package'), { recursive: true });
    const packageManifest = {
      name,
      version,
      ...(name === '@gx-capture/capture-runtime-client'
        ? { contractSetSha256: runtimePackageContractSetSha256 }
        : {}),
    };
    await writeFile(
      join(archiveInput, 'package/package.json'),
      `${JSON.stringify(packageManifest)}\n`,
    );
    const archivePath = join(root, archive);
    const packed = spawnSync(
      'tar',
      ['-czf', archivePath, '-C', archiveInput, 'package'],
      { encoding: 'utf8' },
    );
    if (packed.status !== 0)
      throw new Error(`Unable to create package fixture: ${packed.stderr}`);
    const value = await readFile(archivePath);
    artifactValues.set(archive, value);
    packageEntries.push({
      archive,
      bytes: value.length,
      integrity: integrity(value),
      name,
      sha256: digest(value),
    });
    await writeFile(join(root, archive), value);
  }
  for (const name of [
    'capture_runtime_client-0.4.2-py3-none-any.whl',
    'capture_runtime_client-0.4.2.tar.gz',
  ]) {
    const path = `python/${name}`;
    const value = Buffer.from(`${name}\n`, 'utf8');
    await writeFile(join(root, path), value);
    artifactValues.set(path, value);
  }
  const packageManifest = {
    schemaVersion: '1',
    candidateKind: 'npm-package-set',
    releaseVersion: version,
    packages: packageEntries,
  };
  const packageManifestBytes = Buffer.from(
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  );
  await writeFile(join(root, 'package-manifest.json'), packageManifestBytes);
  artifactValues.set('package-manifest.json', packageManifestBytes);
  const contractBytes = Buffer.from('{"schemaVersion":"1"}\n');
  await writeFile(
    join(root, 'contracts', 'contract-snapshot.json'),
    contractBytes,
  );
  artifactValues.set('contracts/contract-snapshot.json', contractBytes);
  await writeFile(
    join(root, 'contracts', 'contract-set.json'),
    candidateContractSetBytes,
  );
  const contractSetShaBytes = Buffer.from(`${contractSetSha256}\n`, 'utf8');
  await writeFile(
    join(root, 'contracts', 'contract-set.sha256'),
    contractSetShaBytes,
  );
  artifactValues.set('contracts/contract-set.json', candidateContractSetBytes);
  artifactValues.set('contracts/contract-set.sha256', contractSetShaBytes);

  const javaArtifacts = [
    `capture-runtime-client-${version}.jar`,
    `capture-runtime-client-${version}-sources.jar`,
    'pom.xml',
    'capture-runtime-contract-set.sha256',
  ];
  const javaEntries = [];
  for (const name of javaArtifacts) {
    const path = `maven/${name}`;
    const value = Buffer.from(
      name === 'capture-runtime-contract-set.sha256'
        ? `${contractSetSha256}\n`
        : `${name}\n`,
      'utf8',
    );
    await writeFile(join(root, path), value);
    artifactValues.set(path, value);
    javaEntries.push({ path, bytes: value.length, sha256: digest(value) });
  }
  const javaBaseManifest = {
    schemaVersion: '1',
    candidateKind: 'maven-java-sdk',
    sourceCommit,
    releaseVersion: version,
    producerRunId,
    coordinates: {
      groupId: 'com.gx.capture',
      artifactId: 'capture-runtime-client',
      packaging: 'jar',
    },
    contractSetSha256,
    artifacts: javaEntries.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    toolchains: { java: 'test', maven: 'test' },
  };
  const javaManifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        ...javaBaseManifest,
        candidateId: digest(JSON.stringify(javaBaseManifest)),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(root, 'java-candidate-manifest.json'),
    javaManifestBytes,
  );
  artifactValues.set('java-candidate-manifest.json', javaManifestBytes);

  const artifacts = [...artifactValues.entries()]
    .map(([path, value]) => ({
      path,
      bytes: value.length,
      sha256: digest(value),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const baseManifest = {
    schemaVersion: '1',
    candidateKind: 'npm-package-set',
    sourceCommit,
    releaseVersion: version,
    producerRunId,
    packageManifestSha256: digest(packageManifestBytes),
    contractSetSha256,
    artifacts,
    toolchains: { node: 'v24.0.0' },
  };
  const candidateId = digest(JSON.stringify(baseManifest));
  const manifest = { ...baseManifest, candidateId };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, 'candidate-manifest.json'), manifestBytes);
  const manifestSha256 = digest(manifestBytes);
  for (const artifact of artifacts) {
    await writeFile(
      join(root, 'checksums', `${artifact.path.replaceAll('/', '__')}.sha256`),
      `${artifact.sha256}  ${artifact.path}\n`,
    );
  }
  return { root, candidateId, manifestSha256, contractSetSha256 };
}

test('package candidate verification binds the complete npm package set', async () => {
  const candidate = await makeCandidate();
  try {
    await assert.doesNotReject(() =>
      verifyPackageCandidate({
        candidate: candidate.root,
        version,
        sourceCommit,
        producerRunId,
        candidateId: candidate.candidateId,
        candidateManifestSha256: candidate.manifestSha256,
        contractSetSha256: candidate.contractSetSha256,
      }),
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('package candidate verification rejects a packed runtime client with stale contract metadata', async () => {
  const canonicalContractSetBytes = await readFile(
    resolve(
      process.cwd(),
      'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
    ),
  );
  const candidate = await makeCandidate({
    contractSetBytes: canonicalContractSetBytes,
    runtimePackageContractSetSha256: STALE_CONTRACT_SET_SHA256,
  });
  try {
    assert.equal(candidate.contractSetSha256, CANONICAL_CONTRACT_SET_SHA256);
    await assert.rejects(
      () =>
        verifyPackageCandidate({
          candidate: candidate.root,
          version,
          sourceCommit,
          producerRunId,
          candidateId: candidate.candidateId,
          candidateManifestSha256: candidate.manifestSha256,
          contractSetSha256: CANONICAL_CONTRACT_SET_SHA256,
        }),
      /Packed package.*contract-set SHA-256 differs/u,
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('package candidate verification rejects changed archive bytes', async () => {
  const candidate = await makeCandidate();
  try {
    await writeFile(
      join(
        candidate.root,
        'package',
        'gx-capture-capture-workbench-ui-0.4.2.tgz',
      ),
      'tampered',
    );
    await assert.rejects(
      () =>
        verifyPackageCandidate({
          candidate: candidate.root,
          version,
          sourceCommit,
          producerRunId,
          candidateId: candidate.candidateId,
          candidateManifestSha256: candidate.manifestSha256,
          contractSetSha256: candidate.contractSetSha256,
        }),
      /(?:size|digest) differs/u,
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('package candidate verification rejects changed Maven artifact bytes', async () => {
  const candidate = await makeCandidate();
  try {
    await writeFile(
      join(candidate.root, 'maven', 'capture-runtime-client-0.4.2.jar'),
      'tampered',
    );
    await assert.rejects(
      () =>
        verifyPackageCandidate({
          candidate: candidate.root,
          version,
          sourceCommit,
          producerRunId,
          candidateId: candidate.candidateId,
          candidateManifestSha256: candidate.manifestSha256,
          contractSetSha256: candidate.contractSetSha256,
        }),
      /(?:size|digest) differs/u,
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('package candidate verification rejects a mismatched contract-set hash', async () => {
  const candidate = await makeCandidate();
  try {
    await assert.rejects(
      () =>
        verifyPackageCandidate({
          candidate: candidate.root,
          version,
          sourceCommit,
          producerRunId,
          candidateId: candidate.candidateId,
          candidateManifestSha256: candidate.manifestSha256,
          contractSetSha256: 'f'.repeat(64),
        }),
      /Candidate manifest digest differs|contract-set/u,
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('package candidate evidence is required for promotion', async () => {
  const candidate = await makeCandidate();
  try {
    await assert.rejects(
      () =>
        verifyPackageCandidate({
          candidate: candidate.root,
          version,
          sourceCommit,
          producerRunId,
          candidateId: candidate.candidateId,
          candidateManifestSha256: candidate.manifestSha256,
          contractSetSha256: candidate.contractSetSha256,
          requireEvidence: true,
        }),
      /cross-framework-consumers\.json/u,
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('desktop candidate binding requires the exact Package Candidate bytes', async () => {
  const candidate = await makeCandidate();
  const desktop = await mkdtemp(join(tmpdir(), 'capture-desktop-candidate-'));
  try {
    await mkdir(join(desktop, 'package'));
    await cp(join(candidate.root, 'package'), join(desktop, 'package'), {
      recursive: true,
    });
    const packageManifest = JSON.parse(
      await readFile(join(candidate.root, 'candidate-manifest.json'), 'utf8'),
    ) as {
      sourceCommit: string;
      releaseVersion: string;
      candidateId: string;
      artifacts: unknown[];
    };
    await writeFile(
      join(desktop, 'candidate-manifest.json'),
      `${JSON.stringify({
        sourceCommit: packageManifest.sourceCommit,
        releaseVersion: packageManifest.releaseVersion,
        packageCandidateId: packageManifest.candidateId,
        artifacts: packageManifest.artifacts,
      })}\n`,
    );
    await assert.doesNotReject(() =>
      verifyPackageCandidateBinding({
        desktopCandidate: desktop,
        packageCandidate: candidate.root,
        candidateId: candidate.candidateId,
      }),
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(desktop, { recursive: true, force: true });
  }
});
