import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function parseArguments(args: readonly string[]) {
  if (
    args.length !== 4 ||
    args[0] !== '--candidate' ||
    args[2] !== '--version'
  ) {
    throw new Error('Use --candidate <directory> --version <semver>.');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(args[3])) {
    throw new Error('Candidate package version is invalid.');
  }
  return { candidate: resolve(args[1]), version: args[3] };
}

const { candidate, version } = parseArguments(process.argv.slice(2));
const packageDirectory = join(candidate, 'package');
const expected = new Set([
  '@gx-capture/capture-workbench',
  '@gx-capture/capture-contracts',
  '@gx-capture/capture-structuring',
]);
const archives = readdirSync(packageDirectory).filter((name) =>
  name.endsWith('.tgz'),
);
if (archives.length !== expected.size)
  throw new Error('Candidate package inventory is incomplete.');
const found = new Set<string>();
for (const archive of archives) {
  if (!statSync(join(packageDirectory, archive)).isFile())
    throw new Error('Candidate package is not a regular file.');
  const result = spawnSync(
    'tar',
    ['-xOf', join(packageDirectory, archive), 'package/package.json'],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`Unable to inspect candidate package ${archive}.`);
  const manifest = JSON.parse(result.stdout) as {
    name?: unknown;
    version?: unknown;
    dependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
  };
  if (
    typeof manifest.name !== 'string' ||
    !expected.has(manifest.name) ||
    found.has(manifest.name)
  ) {
    throw new Error(`Candidate package identity is invalid: ${archive}.`);
  }
  if (manifest.version !== version)
    throw new Error(
      `Candidate package ${manifest.name} has the wrong version.`,
    );
  found.add(manifest.name);
  for (const dependency of [
    ...Object.values(manifest.dependencies ?? {}),
    ...Object.values(manifest.peerDependencies ?? {}),
  ]) {
    if (dependency === 'workspace:*')
      throw new Error(`Candidate package ${manifest.name} leaks workspace:*.`);
  }
}
if (found.size !== expected.size)
  throw new Error(
    'Candidate package inventory has missing package identities.',
  );
process.stdout.write(
  `Candidate package exports and dependency boundaries passed for ${version}.\n`,
);
