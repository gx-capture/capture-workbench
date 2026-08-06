import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  assertRegularTextFile,
  collectReleaseVersionEntries,
  loadReleaseIntent,
  replaceReleaseVersion,
  verifyGeneratedVersions,
  workspaceRoot,
} from './version-sources.ts';

const TEXT_EXTENSIONS = new Set([
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.toml',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
]);
const SKIPPED_SEGMENTS = new Set([
  '.angular',
  '.build',
  '.git',
  '.mypy_cache',
  '.nx',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'dist',
  'node_modules',
  'target',
]);
const SKIPPED_NAMES = new Set(['Cargo.lock', 'pnpm-lock.yaml', 'uv.lock']);

function filesUnder(root: string, relativeDirectory: string): string[] {
  const directory = resolve(root, relativeDirectory);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_SEGMENTS.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(root, relative(root, path)));
      continue;
    }
    if (
      SKIPPED_NAMES.has(entry.name) ||
      !TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))
    ) {
      continue;
    }
    files.push(path);
  }
  return files;
}

export function synchronizeReleaseVersion(
  root = workspaceRoot,
  { check = false } = {},
): string[] {
  const intent = loadReleaseIntent(root);
  const current = JSON.parse(
    readFileSync(
      resolve(root, 'packages/capture-angular/package.json'),
      'utf8',
    ),
  ).version as string;
  const previousVersions = new Set(
    collectReleaseVersionEntries(root)
      .map((entry) => entry.value)
      .filter(
        (value): value is string =>
          value !== undefined && value !== intent.releaseVersion,
      ),
  );
  if (previousVersions.size > 1) {
    throw new Error(
      `Release-managed files contain multiple previous versions: ${[
        ...previousVersions,
      ].join(', ')}`,
    );
  }
  const previous = [...previousVersions][0] ?? current;
  if (current === intent.releaseVersion && previousVersions.size === 0) {
    verifyGeneratedVersions(root);
    return [];
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(previous)) {
    throw new Error(`Current release version is invalid: ${previous}`);
  }
  const changed: string[] = [];
  for (const path of [
    ...filesUnder(root, 'packages'),
    ...filesUnder(root, 'apps'),
    ...filesUnder(root, 'tools'),
  ]) {
    assertRegularTextFile(path);
    const before = readFileSync(path, 'utf8');
    const after = replaceReleaseVersion(before, previous, intent.releaseVersion);
    if (before === after) continue;
    changed.push(relative(root, path));
    if (!check) writeFileSync(path, after, 'utf8');
  }
  if (check) {
    verifyGeneratedVersions(root);
  } else {
    verifyGeneratedVersions(root);
  }
  return changed;
}

const check = process.argv.includes('--check');
try {
  const changed = synchronizeReleaseVersion(workspaceRoot, { check });
  process.stdout.write(
    check
      ? 'Generated release versions are synchronized.\n'
      : `${changed.length} release-managed files synchronized.\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
