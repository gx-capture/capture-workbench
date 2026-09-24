import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createContractSnapshot } from './create-contract-snapshot.ts';
import { verifyPackageCandidate } from './verify-package-candidate.ts';

type ReleaseMode = 'core-only' | 'model-enabled';

function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        '--output',
        '--version',
        '--source-commit',
        '--producer-run-id',
        '--package-candidate-id',
        '--package-candidate',
        '--package-producer-run-id',
        '--package-candidate-manifest-sha256',
        '--contract-set-sha256',
        '--release-mode',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --output <directory> --version <semver> --source-commit <sha> --producer-run-id <id> --package-candidate <directory> --package-candidate-id <sha> --package-producer-run-id <id> --package-candidate-manifest-sha256 <sha> --contract-set-sha256 <sha> --release-mode <mode>.',
      );
    }
    values.set(name, value);
  }
  const output = values.get('--output');
  const version = values.get('--version');
  const sourceCommit = values.get('--source-commit');
  const producerRunId = Number(values.get('--producer-run-id'));
  const packageCandidateId = values.get('--package-candidate-id');
  const packageCandidate = values.get('--package-candidate');
  const packageProducerRunId = Number(values.get('--package-producer-run-id'));
  const packageCandidateManifestSha256 = values.get(
    '--package-candidate-manifest-sha256',
  );
  const contractSetSha256 = values.get('--contract-set-sha256');
  const releaseMode = values.get('--release-mode');
  if (
    !output ||
    !version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    !sourceCommit ||
    !/^[0-9a-f]{40}$/u.test(sourceCommit) ||
    !Number.isSafeInteger(producerRunId) ||
    producerRunId < 1 ||
    !packageCandidateId ||
    !/^[0-9a-f]{64}$/u.test(packageCandidateId) ||
    !packageCandidate ||
    !Number.isSafeInteger(packageProducerRunId) ||
    packageProducerRunId < 1 ||
    !packageCandidateManifestSha256 ||
    !/^[0-9a-f]{64}$/u.test(packageCandidateManifestSha256) ||
    !contractSetSha256 ||
    !/^[0-9a-f]{64}$/u.test(contractSetSha256) ||
    !releaseMode ||
    !['core-only', 'model-enabled'].includes(releaseMode)
  ) {
    throw new Error(
      'Use --output <directory> --version <semver> --source-commit <sha> --producer-run-id <id> --package-candidate <directory> --package-candidate-id <sha> --package-producer-run-id <id> --package-candidate-manifest-sha256 <sha> --contract-set-sha256 <sha> --release-mode <mode>.',
    );
  }
  return {
    output: resolve(output),
    version,
    sourceCommit,
    producerRunId,
    packageCandidateId,
    packageCandidate: resolve(packageCandidate),
    packageProducerRunId,
    packageCandidateManifestSha256,
    contractSetSha256,
    releaseMode: releaseMode as ReleaseMode,
  };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function verifiedPackagePython(input: ReturnType<typeof parseArguments>) {
  assert(
    (await lstat(input.packageCandidate)).isDirectory(),
    'Package candidate must be a regular directory.',
  );
  const manifestPath = join(input.packageCandidate, 'candidate-manifest.json');
  assert(
    (await lstat(manifestPath)).isFile(),
    'Package manifest must be a regular file.',
  );
  const manifestBytes = await readFile(manifestPath);
  assert.equal(
    createHash('sha256').update(manifestBytes).digest('hex'),
    input.packageCandidateManifestSha256,
    'Package manifest digest differs.',
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    artifacts?: Array<{ path: string; bytes: number; sha256: string }>;
  };
  assert(
    Array.isArray(manifest.artifacts),
    'Package artifact inventory is invalid.',
  );
  const paths = new Set<string>();
  for (const item of manifest.artifacts) {
    assert(
      item &&
        typeof item.path === 'string' &&
        /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(item.path) &&
        item.path.split('/').every((part) => part !== '.' && part !== '..'),
      'Package artifact path is not canonical.',
    );
    assert(
      !paths.has(item.path.toLowerCase()),
      'Package artifact inventory contains duplicate paths.',
    );
    paths.add(item.path.toLowerCase());
  }
  await verifyPackageCandidate({
    candidate: input.packageCandidate,
    version: input.version,
    sourceCommit: input.sourceCommit,
    producerRunId: input.packageProducerRunId,
    candidateId: input.packageCandidateId,
    candidateManifestSha256: input.packageCandidateManifestSha256,
    contractSetSha256: input.contractSetSha256,
    requireEvidence: true,
  });
  const directory = join(input.packageCandidate, 'python');
  assert(
    (await lstat(directory)).isDirectory(),
    'Package Python directory must be regular.',
  );
  const names = (await readdir(directory)).sort();
  const version = input.version.replaceAll('.', '\\.');
  const wheel = new RegExp(
    `^capture_runtime_client-${version}-(?:[0-9][A-Za-z0-9_]*-)?[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\\.whl$`,
    'u',
  );
  assert(
    names.length === 2 &&
      names.filter((name) => wheel.test(name)).length === 1 &&
      names.includes(`capture_runtime_client-${input.version}.tar.gz`),
    'Package must contain exactly one version-matched wheel and sdist.',
  );
  const records = manifest.artifacts.filter((item) =>
    item.path.startsWith('python/'),
  );
  assert.deepEqual(
    records.map((item) => item.path.slice(7)).sort(),
    names,
    'Package Python inventory differs.',
  );
  const distributions = [];
  for (const name of names) {
    const path = join(directory, name);
    assert(
      (await lstat(path)).isFile(),
      'Package Python artifact must be a regular file.',
    );
    const bytes = await readFile(path);
    const record = records.find((item) => item.path === `python/${name}`);
    assert(record, 'Package Python archive is missing from inventory.');
    assert.equal(bytes.length, record.bytes, 'Package Python size differs.');
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      record.sha256,
      'Package Python digest differs.',
    );
    distributions.push({ name, bytes, sha256: record.sha256 });
  }
  assert.equal(
    await sha256(manifestPath),
    input.packageCandidateManifestSha256,
    'Package manifest changed during verification.',
  );
  return distributions;
}

async function inventory(root: string, directories: readonly string[]) {
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const directory of directories) {
    for (const name of await readdir(join(root, directory))) {
      const path = join(directory, name);
      const normalizedPath = path.replaceAll('\\', '/');
      const metadata = await stat(join(root, path));
      if (!metadata.isFile())
        throw new Error(`Expected a regular runtime artifact: ${path}.`);
      entries.push({
        path: normalizedPath,
        bytes: metadata.size,
        sha256: await sha256(join(root, path)),
      });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  const {
    output,
    version,
    sourceCommit,
    producerRunId,
    packageCandidateId,
    releaseMode,
  } = input;
  const distributions = await verifiedPackagePython(input);
  const root = resolve(import.meta.dirname, '..');
  const runtime = join(output, 'runtime');
  const python = join(output, 'python');
  const crate = join(output, 'crate');
  const contracts = join(output, 'contracts');
  const checksums = join(output, 'checksums');
  await mkdir(output, { recursive: false });
  await Promise.all(
    [runtime, python, crate, contracts, checksums].map((path) => mkdir(path)),
  );

  await cp(resolve(root, 'packages/capture-runtime/dist/release'), runtime, {
    recursive: true,
  });
  for (const distribution of distributions) {
    const destination = join(python, distribution.name);
    await writeFile(destination, distribution.bytes, { flag: 'wx' });
    assert.equal(
      await sha256(destination),
      distribution.sha256,
      'Copied Python artifact differs from the verified package.',
    );
  }
  const crateName = `capture-sidecar-launcher-${version}.crate`;
  await cp(
    resolve(
      root,
      `packages/capture-sidecar-launcher/target/package/${crateName}`,
    ),
    join(crate, crateName),
  );
  await writeFile(
    join(contracts, 'contract-snapshot.json'),
    `${JSON.stringify(await createContractSnapshot(root), null, 2)}\n`,
    'utf8',
  );
  const contractSetJson = resolve(
    root,
    'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
  );
  const contractSetShaPath = resolve(
    root,
    'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
  );
  const contractSetSha256 = (await readFile(contractSetShaPath, 'utf8')).trim();
  assert.equal(
    contractSetSha256,
    input.contractSetSha256,
    'Runtime source contract differs from the verified package contract.',
  );
  if (
    !/^[0-9a-f]{64}$/u.test(contractSetSha256) ||
    (await sha256(contractSetJson)) !== contractSetSha256
  ) {
    throw new Error('Canonical v2 contract-set bundle/hash is invalid.');
  }
  await cp(contractSetJson, join(contracts, 'contract-set.json'));
  await cp(contractSetShaPath, join(contracts, 'contract-set.sha256'));

  const artifacts = await inventory(output, [
    'runtime',
    'python',
    'crate',
    'contracts',
  ]);
  for (const artifact of artifacts) {
    await writeFile(
      join(checksums, `${artifact.path.replaceAll('/', '__')}.sha256`),
      `${artifact.sha256}  ${artifact.path}\n`,
      'utf8',
    );
  }
  const baseManifest = {
    schemaVersion: '1',
    candidateKind: 'runtime',
    sourceCommit,
    releaseVersion: version,
    releaseMode,
    producerRunId,
    packageCandidateId,
    contractSetSha256,
    artifacts,
    toolchains: {
      node: process.version,
      python: '3.12',
      runtime: 'capture-runtime',
    },
  } as const;
  const candidateId = createHash('sha256')
    .update(JSON.stringify(baseManifest))
    .digest('hex');
  const manifest = { ...baseManifest, candidateId };
  const manifestPath = join(output, 'candidate-manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    `${manifestPath}.sha256`,
    `${await sha256(manifestPath)}  candidate-manifest.json\n`,
    'utf8',
  );
  process.stdout.write(
    `Assembled runtime candidate ${version} (${candidateId}) at ${output}.\n`,
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
