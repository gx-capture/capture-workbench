import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createContractSnapshot } from './create-contract-snapshot.ts';

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
        '--release-mode',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --output <directory> --version <semver> --source-commit <sha> --producer-run-id <id> --package-candidate-id <sha> --release-mode <mode>.',
      );
    }
    values.set(name, value);
  }
  const output = values.get('--output');
  const version = values.get('--version');
  const sourceCommit = values.get('--source-commit');
  const producerRunId = Number(values.get('--producer-run-id'));
  const packageCandidateId = values.get('--package-candidate-id');
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
    !releaseMode ||
    !['core-only', 'model-enabled'].includes(releaseMode)
  ) {
    throw new Error(
      'Use --output <directory> --version <semver> --source-commit <sha> --producer-run-id <id> --package-candidate-id <sha> --release-mode <mode>.',
    );
  }
  return {
    output: resolve(output),
    version,
    sourceCommit,
    producerRunId,
    packageCandidateId,
    releaseMode: releaseMode as ReleaseMode,
  };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function copyMatching(
  sourceDirectory: string,
  destinationDirectory: string,
  pattern: RegExp,
  expectedCount: number,
): Promise<string[]> {
  const names = (await readdir(sourceDirectory)).filter((name) =>
    pattern.test(name),
  );
  if (names.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} artifacts matching ${pattern} in ${sourceDirectory}; found ${names.length}.`,
    );
  }
  for (const name of names)
    await cp(join(sourceDirectory, name), join(destinationDirectory, name));
  return names.sort();
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
  const {
    output,
    version,
    sourceCommit,
    producerRunId,
    packageCandidateId,
    releaseMode,
  } = parseArguments(process.argv.slice(2));
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
  await copyMatching(
    resolve(root, 'packages/capture-runtime-client-python/dist'),
    python,
    new RegExp(
      `^capture_runtime_client-${version.replaceAll('.', '\\.')}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`,
      'u',
    ),
    2,
  );
  await copyMatching(
    resolve(root, 'packages/capture-structuring-python/dist'),
    python,
    new RegExp(
      `^capture_structuring-${version.replaceAll('.', '\\.')}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`,
      'u',
    ),
    2,
  );
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
