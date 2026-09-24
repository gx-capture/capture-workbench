import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { verifyRuntimeCandidate } from './verify-runtime-candidate.ts';

const version = '0.4.2';
const sourceCommit = 'a'.repeat(40);
const producerRunId = 12345;
const contractSetBytes = Buffer.from('{"contractSetVersion":"2"}\n', 'utf8');
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

async function assemblyFixture(localDist: boolean) {
  const candidate = await makeCandidate();
  const sourceRoot = join(candidate.root, 'source-root');
  const output = join(candidate.root, 'assembled-runtime');
  await writeFile(
    join(candidate.root, 'cross-framework-consumers.json'),
    JSON.stringify({
      schemaVersion: '1',
      candidateId: candidate.candidateId,
      verification: 'cross-framework-consumers',
      status: 'success',
    }),
  );
  const files = new Map<string, string | Buffer>([
    ['packages/capture-runtime/pyproject.toml', 'version = "0.4.2"\n'],
    [
      'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
      contractSetBytes,
    ],
    [
      'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
      candidate.contractSetSha256,
    ],
    [
      'packages/capture-runtime/dist/release/capture-runtime.exe',
      'runtime executable fixture',
    ],
    [
      'packages/capture-runtime/dist/release/capture-document-v2.schema.json',
      '{}',
    ],
    [
      'packages/capture-runtime/dist/release/capture-runtime-manifest.json',
      JSON.stringify({
        runtimeVersion: version,
        schemaFileName: 'capture-document-v2.schema.json',
        schemaSha256: digest('{}'),
      }),
    ],
    [
      'packages/capture-runtime/dist/release/capture-engine-catalog.json',
      JSON.stringify({ runtimeVersion: version }),
    ],
    [
      'packages/capture-sidecar-launcher/target/package/capture-sidecar-launcher-0.4.2.crate',
      'crate fixture',
    ],
  ]);
  if (localDist) {
    files.set(
      'packages/capture-runtime-client-python/dist/capture_runtime_client-0.4.2-py3-none-any.whl',
      'DIFFERENT LOCAL WHEEL',
    );
    files.set(
      'packages/capture-runtime-client-python/dist/capture_runtime_client-0.4.2.tar.gz',
      'DIFFERENT LOCAL SDIST',
    );
  }
  for (const [path, bytes] of files) {
    await mkdir(join(sourceRoot, path, '..'), { recursive: true });
    await writeFile(join(sourceRoot, path), bytes);
  }
  // Run the production CLI in an isolated source tree, never shared local dist.
  await mkdir(join(sourceRoot, 'tools'), { recursive: true });
  for (const name of [
    'assemble-runtime-candidate.ts',
    'create-contract-snapshot.ts',
    'verify-package-candidate.ts',
    'verify-packed-package.ts',
  ]) {
    await cp(join(import.meta.dirname, name), join(sourceRoot, 'tools', name));
  }
  const args = [
    '--output',
    output,
    '--version',
    version,
    '--source-commit',
    sourceCommit,
    '--producer-run-id',
    '98765',
    '--package-candidate',
    candidate.root,
    '--package-candidate-id',
    candidate.candidateId,
    '--package-producer-run-id',
    String(producerRunId),
    '--package-candidate-manifest-sha256',
    candidate.manifestSha256,
    '--contract-set-sha256',
    candidate.contractSetSha256,
    '--release-mode',
    'core-only',
  ];
  return { candidate, sourceRoot, output, args };
}

for (const localDist of [false, true]) {
  test(`runtime assembly reuses verified package wheel and sdist with local dist ${localDist ? 'different' : 'absent'}`, async () => {
    const fixture = await assemblyFixture(localDist);
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(fixture.sourceRoot, 'tools/assemble-runtime-candidate.ts'),
          ...fixture.args,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      for (const name of [
        'capture_runtime_client-0.4.2-py3-none-any.whl',
        'capture_runtime_client-0.4.2.tar.gz',
      ]) {
        assert.deepEqual(
          await readFile(join(fixture.output, 'python', name)),
          await readFile(join(fixture.candidate.root, 'python', name)),
        );
      }
      const manifestBytes = await readFile(
        join(fixture.output, 'candidate-manifest.json'),
      );
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      await verifyRuntimeCandidate({
        candidate: fixture.output,
        version,
        sourceCommit,
        producerRunId: 98765,
        candidateId: manifest.candidateId,
        candidateManifestSha256: digest(manifestBytes),
        packageCandidateId: fixture.candidate.candidateId,
        contractSetSha256: fixture.candidate.contractSetSha256,
      });
    } finally {
      await rm(fixture.candidate.root, { recursive: true, force: true });
    }
  });
}

test('runtime assembly rejects incomplete or conflicting package origin before creating output', async () => {
  const fixture = await assemblyFixture(true);
  try {
    for (const name of [
      '--package-candidate',
      '--package-candidate-id',
      '--package-producer-run-id',
      '--package-candidate-manifest-sha256',
      '--contract-set-sha256',
    ]) {
      const args = [...fixture.args];
      args.splice(args.indexOf(name), 2);
      const result = spawnSync(
        process.execPath,
        [
          join(fixture.sourceRoot, 'tools/assemble-runtime-candidate.ts'),
          ...args,
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0, `missing ${name}`);
      await assert.rejects(
        readFile(join(fixture.output, 'candidate-manifest.json')),
        { code: 'ENOENT' },
      );
    }
    for (const [name, value] of [
      ['--package-candidate-id', 'f'.repeat(64)],
      ['--package-candidate-manifest-sha256', 'f'.repeat(64)],
      ['--contract-set-sha256', 'f'.repeat(64)],
      ['--source-commit', 'f'.repeat(40)],
      ['--version', '0.4.3'],
      ['--package-producer-run-id', '54321'],
    ]) {
      const args = [...fixture.args];
      args[args.indexOf(name) + 1] = value;
      const result = spawnSync(
        process.execPath,
        [
          join(fixture.sourceRoot, 'tools/assemble-runtime-candidate.ts'),
          ...args,
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0, `conflicting ${name}`);
      await assert.rejects(
        readFile(join(fixture.output, 'candidate-manifest.json')),
        { code: 'ENOENT' },
      );
    }
  } finally {
    await rm(fixture.candidate.root, { recursive: true, force: true });
  }
});

test('runtime assembly fails closed on package evidence, archive, manifest and duplicate inventory changes', async () => {
  for (const target of [
    'evidence',
    'archive',
    'manifest',
    'duplicate',
    'two-wheels',
  ]) {
    const fixture = await assemblyFixture(true);
    try {
      if (target === 'evidence')
        await rm(
          join(fixture.candidate.root, 'cross-framework-consumers.json'),
        );
      else if (target === 'archive')
        await writeFile(
          join(
            fixture.candidate.root,
            'python/capture_runtime_client-0.4.2-py3-none-any.whl',
          ),
          'substituted package bytes',
        );
      else if (target === 'manifest')
        await writeFile(
          join(fixture.candidate.root, 'candidate-manifest.json'),
          '{}',
        );
      else {
        const path = join(fixture.candidate.root, 'candidate-manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        if (target === 'duplicate')
          manifest.artifacts.push(manifest.artifacts[0]);
        else {
          const artifact = manifest.artifacts.find((item: { path: string }) =>
            item.path.endsWith('.tar.gz'),
          );
          const oldPath = artifact.path;
          artifact.path =
            'python/capture_runtime_client-0.4.2-cp312-none-any.whl';
          await cp(
            join(fixture.candidate.root, oldPath),
            join(fixture.candidate.root, artifact.path),
          );
          await rm(join(fixture.candidate.root, oldPath));
          await writeFile(
            join(
              fixture.candidate.root,
              'checksums',
              `${artifact.path.replaceAll('/', '__')}.sha256`,
            ),
            `${artifact.sha256}  ${artifact.path}\n`,
          );
        }
        delete manifest.candidateId;
        const candidateId = digest(JSON.stringify(manifest));
        const bytes = JSON.stringify({ ...manifest, candidateId });
        await writeFile(path, bytes);
        fixture.args[fixture.args.indexOf('--package-candidate-id') + 1] =
          candidateId;
        fixture.args[
          fixture.args.indexOf('--package-candidate-manifest-sha256') + 1
        ] = digest(bytes);
        await writeFile(
          join(fixture.candidate.root, 'cross-framework-consumers.json'),
          JSON.stringify({
            schemaVersion: '1',
            candidateId,
            verification: 'cross-framework-consumers',
            status: 'success',
          }),
        );
      }
      const result = spawnSync(
        process.execPath,
        [
          join(fixture.sourceRoot, 'tools/assemble-runtime-candidate.ts'),
          ...fixture.args,
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0, target);
      if (target === 'two-wheels')
        assert.match(result.stderr, /one version-matched wheel and sdist/u);
      if (target === 'duplicate')
        assert.match(result.stderr, /duplicate paths/u);
      await assert.rejects(
        readFile(join(fixture.output, 'candidate-manifest.json')),
        { code: 'ENOENT' },
      );
    } finally {
      await rm(fixture.candidate.root, { recursive: true, force: true });
    }
  }
});
