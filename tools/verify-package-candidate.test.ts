import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { verifyPackageCandidate } from './verify-package-candidate.ts';
import { verifyPackageCandidateBinding } from './verify-package-candidate-binding.ts';

const version = '0.4.1';
const sourceCommit = 'a'.repeat(40);
const producerRunId = 12345;
const contractSetBytes = Buffer.from('{"catalogVersion":"2"}\n', 'utf8');
const packages = [
  ['@gx-capture/capture-workbench-ui', 'gx-capture-capture-workbench-ui'],
  ['@gx-capture/capture-runtime-client', 'gx-capture-capture-runtime-client'],
  ['@gx-capture/capture-structuring', 'gx-capture-capture-structuring'],
] as const;

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function integrity(value: Buffer): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

async function makeCandidate(): Promise<{
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
  const artifactValues = new Map<string, Buffer>();
  const packageEntries = [];
  for (const [name, archiveBase] of packages) {
    const archive = `package/${archiveBase}-${version}.tgz`;
    const value = Buffer.from(`${name}\n`, 'utf8');
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
    'capture_runtime_client-0.4.1-py3-none-any.whl',
    'capture_runtime_client-0.4.1.tar.gz',
    'capture_structuring-0.4.1-py3-none-any.whl',
    'capture_structuring-0.4.1.tar.gz',
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
    contractSetBytes,
  );
  const contractSetSha256 = digest(contractSetBytes);
  const contractSetShaBytes = Buffer.from(`${contractSetSha256}\n`, 'utf8');
  await writeFile(
    join(root, 'contracts', 'contract-set.sha256'),
    contractSetShaBytes,
  );
  artifactValues.set('contracts/contract-set.json', contractSetBytes);
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

test('package candidate verification rejects changed archive bytes', async () => {
  const candidate = await makeCandidate();
  try {
    await writeFile(
      join(
        candidate.root,
        'package',
        'gx-capture-capture-workbench-ui-0.4.1.tgz',
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
      join(candidate.root, 'maven', 'capture-runtime-client-0.4.1.jar'),
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
