import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REGISTRY = 'https://npm.pkg.github.com';
const PACKAGE_NAMES = new Set([
  '@gx-capture/capture-workbench',
  '@gx-capture/capture-contracts',
  '@gx-capture/capture-structuring',
]);

export type NpmPublicationDecision = 'publish' | 'already-published';

export function packagePublicationDecision(
  existingIntegrity: string | undefined,
  localIntegrity: string,
): NpmPublicationDecision {
  if (existingIntegrity === undefined) return 'publish';
  if (existingIntegrity === localIntegrity) return 'already-published';
  throw new Error(
    'Published npm package integrity differs from the approved candidate.',
  );
}

function run(command: string, args: readonly string[], allowFailure = false) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} failed with status ${String(result.status)}.`);
  }
  return result;
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--candidate', '--version', '--output'].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --candidate <directory> --version <semver> --output <file>.',
      );
    }
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error(
      'Use --candidate <directory> --version <semver> --output <file>.',
    );
  }
  return values;
}

function existingIntegrity(name: string, version: string): string | undefined {
  const result = run(
    'npm',
    [
      'view',
      `${name}@${version}`,
      'dist.integrity',
      '--json',
      '--registry',
      REGISTRY,
    ],
    true,
  );
  if (result.status !== 0) {
    if (/E404|404 Not Found|not found/iu.test(result.stderr || result.stdout)) {
      return undefined;
    }
    throw new Error('Unable to inspect the existing npm package version.');
  }
  const value = JSON.parse(result.stdout) as unknown;
  if (typeof value !== 'string' || !/^sha512-/u.test(value)) {
    throw new Error(
      'Registry returned an invalid npm package integrity value.',
    );
  }
  return value;
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const candidate = resolve(values.get('--candidate')!);
  const version = values.get('--version')!;
  const output = resolve(values.get('--output')!);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Npm candidate version is invalid.');
  }
  const manifest = JSON.parse(
    await readFile(join(candidate, 'candidate-manifest.json'), 'utf8'),
  ) as { candidateId?: unknown };
  if (
    typeof manifest.candidateId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(manifest.candidateId)
  ) {
    throw new Error('Npm candidate manifest has no valid candidate ID.');
  }
  const packagePaths = (await readdir(join(candidate, 'package')))
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => join(candidate, 'package', name));
  if (packagePaths.length !== PACKAGE_NAMES.size) {
    throw new Error(
      `Expected exactly ${PACKAGE_NAMES.size} npm package candidates.`,
    );
  }
  const packages: Array<{
    name: string;
    version: string;
    integrity: string;
    decision: NpmPublicationDecision;
  }> = [];
  for (const packagePath of packagePaths) {
    const inspection = JSON.parse(
      run('npm', ['pack', '--dry-run', '--json', packagePath]).stdout,
    ) as unknown;
    if (!Array.isArray(inspection) || inspection.length !== 1) {
      throw new Error(`Npm package inspection is invalid: ${packagePath}.`);
    }
    const packageInfo = inspection[0] as {
      name?: unknown;
      version?: unknown;
      integrity?: unknown;
    };
    if (
      typeof packageInfo.name !== 'string' ||
      !PACKAGE_NAMES.has(packageInfo.name) ||
      packageInfo.version !== version ||
      typeof packageInfo.integrity !== 'string' ||
      !/^sha512-/u.test(packageInfo.integrity)
    ) {
      throw new Error(
        `Npm package identity differs from the approved candidate: ${packagePath}.`,
      );
    }
    const decision = packagePublicationDecision(
      existingIntegrity(packageInfo.name, version),
      packageInfo.integrity,
    );
    if (decision === 'publish') {
      run('npm', [
        'publish',
        packagePath,
        '--registry',
        REGISTRY,
        '--access',
        'public',
      ]);
    }
    const publishedIntegrity = existingIntegrity(packageInfo.name, version);
    if (publishedIntegrity === undefined) {
      throw new Error(
        `Npm package was not visible after publication: ${packageInfo.name}.`,
      );
    }
    packagePublicationDecision(publishedIntegrity, packageInfo.integrity);
    packages.push({
      name: packageInfo.name,
      version,
      integrity: packageInfo.integrity,
      decision,
    });
  }
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: '1',
        registry: 'npm',
        candidateId: manifest.candidateId,
        releaseVersion: version,
        status: 'published',
        packages: packages.sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      },
      null,
      2,
    )}\n`,
    'utf8',
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
