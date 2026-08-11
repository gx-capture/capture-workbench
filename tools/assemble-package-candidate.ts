import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createContractSnapshot } from './create-contract-snapshot.ts';

const PACKAGE_FILES = new Map([
  ['gx-capture-capture-workbench', '@gx-capture/capture-workbench'],
  ['gx-capture-capture-contracts', '@gx-capture/capture-contracts'],
  ['gx-capture-capture-structuring', '@gx-capture/capture-structuring'],
]);

export type PackageCandidateManifest = {
  readonly schemaVersion: '1';
  readonly candidateKind: 'npm-package-set';
  readonly candidateId: string;
  readonly sourceCommit: string;
  readonly releaseVersion: string;
  readonly producerRunId: number;
  readonly packageManifestSha256: string;
  readonly artifacts: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly toolchains: Readonly<Record<string, string>>;
};

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
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --output <directory> --version <semver> --source-commit <sha> --producer-run-id <id>.',
      );
    }
    values.set(name, value);
  }
  const output = values.get('--output');
  const version = values.get('--version');
  const sourceCommit = values.get('--source-commit');
  const producerRunId = Number(values.get('--producer-run-id'));
  if (
    !output ||
    !version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    !sourceCommit ||
    !/^[0-9a-f]{40}$/u.test(sourceCommit) ||
    !Number.isSafeInteger(producerRunId) ||
    producerRunId < 1
  ) {
    throw new Error(
      'Use --output <directory> --version <semver> --source-commit <sha> --producer-run-id <id>.',
    );
  }
  return {
    output: resolve(output),
    version,
    sourceCommit,
    producerRunId,
  };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function inventory(root: string, paths: readonly string[]) {
  return Promise.all(
    paths.map(async (path) => {
      const absolute = join(root, path);
      const metadata = await stat(absolute);
      if (!metadata.isFile())
        throw new Error(`Expected a regular file: ${path}.`);
      return {
        path: path.replaceAll('\\', '/'),
        bytes: metadata.size,
        sha256: await sha256(absolute),
      };
    }),
  );
}

async function main(): Promise<void> {
  const { output, version, sourceCommit, producerRunId } = parseArguments(
    process.argv.slice(2),
  );
  const root = resolve(import.meta.dirname, '..');
  const packageDirectory = join(output, 'package');
  const contractsDirectory = join(output, 'contracts');
  const checksumsDirectory = join(output, 'checksums');
  await mkdir(output, { recursive: false });
  await Promise.all([
    mkdir(packageDirectory),
    mkdir(contractsDirectory),
    mkdir(checksumsDirectory),
  ]);

  const packDirectory = resolve(root, 'dist/packs');
  const expectedArchives = new Set(
    [...PACKAGE_FILES.keys()].map((name) => `${name}-${version}.tgz`),
  );
  const availableArchives = new Set(
    (await readdir(packDirectory)).filter((name) => expectedArchives.has(name)),
  );
  if (availableArchives.size !== expectedArchives.size) {
    throw new Error(
      `Expected exactly ${expectedArchives.size} synchronized npm archives; found ${availableArchives.size}.`,
    );
  }
  const archiveNames = [...availableArchives].sort();
  await Promise.all(
    archiveNames.map((name) =>
      cp(join(packDirectory, name), join(packageDirectory, name)),
    ),
  );

  const packageManifest = {
    schemaVersion: '1',
    candidateKind: 'npm-package-set',
    releaseVersion: version,
    packages: await Promise.all(
      archiveNames.map(async (archiveName) => {
        const archivePath = join(packageDirectory, archiveName);
        const metadata = await stat(archivePath);
        return {
          name: PACKAGE_FILES.get(
            archiveName.slice(0, archiveName.length - (version.length + 5)),
          )!,
          archive: `package/${archiveName}`,
          bytes: metadata.size,
          sha256: await sha256(archivePath),
          integrity: `sha512-${createHash('sha512')
            .update(await readFile(archivePath))
            .digest('base64')}`,
        };
      }),
    ),
  };
  const packageManifestPath = join(output, 'package-manifest.json');
  await writeFile(
    packageManifestPath,
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    'utf8',
  );
  const packageManifestSha256 = await sha256(packageManifestPath);
  await writeFile(
    `${packageManifestPath}.sha256`,
    `${packageManifestSha256}  package-manifest.json\n`,
    'utf8',
  );

  await writeFile(
    join(contractsDirectory, 'contract-snapshot.json'),
    `${JSON.stringify(await createContractSnapshot(root), null, 2)}\n`,
    'utf8',
  );
  const artifactPaths = [
    ...archiveNames.map((name) => `package/${name}`),
    'package-manifest.json',
    'contracts/contract-snapshot.json',
  ];
  const artifacts = (await inventory(output, artifactPaths)).sort(
    (left, right) => left.path.localeCompare(right.path),
  );
  const baseManifest = {
    schemaVersion: '1',
    candidateKind: 'npm-package-set',
    sourceCommit,
    releaseVersion: version,
    producerRunId,
    packageManifestSha256,
    artifacts,
    toolchains: { node: process.version },
  } as const;
  const candidateId = createHash('sha256')
    .update(JSON.stringify(baseManifest))
    .digest('hex');
  const manifest: PackageCandidateManifest = { ...baseManifest, candidateId };
  const manifestPath = join(output, 'candidate-manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  const manifestSha256 = await sha256(manifestPath);
  await writeFile(
    `${manifestPath}.sha256`,
    `${manifestSha256}  candidate-manifest.json\n`,
    'utf8',
  );
  for (const artifact of artifacts) {
    await writeFile(
      join(checksumsDirectory, `${artifact.path.replaceAll('/', '__')}.sha256`),
      `${artifact.sha256}  ${artifact.path}\n`,
      'utf8',
    );
  }
  process.stdout.write(
    `Assembled npm package candidate ${version} (${candidateId}) at ${output}.\n`,
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
