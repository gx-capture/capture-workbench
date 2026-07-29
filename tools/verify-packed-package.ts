import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageDirectory = resolve(process.argv[2] ?? 'dist/packages/capture-angular');
const archiveDirectory = resolve(process.argv[3] ?? 'dist/packs');
const manifest = JSON.parse(
  readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
);
const archiveName = `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`;
const archivePath = join(archiveDirectory, archiveName);

assert(manifest.name === '@gx-capture/capture-workbench', 'Unexpected package name.');
assert(manifest.version === '0.3.1', 'Unexpected package version.');
assert(
  manifest.repository?.url ===
    'git+https://github.com/gx-capture/capture-workbench.git',
  'Unexpected package repository.',
);
assert(
  manifest.homepage ===
    'https://github.com/gx-capture/capture-workbench#readme',
  'Unexpected package homepage.',
);
assert(
  manifest.peerDependencies?.['@angular/forms'] === '^22.0.0',
  'The packed package must peer-depend on @angular/forms.',
);
assert(
  manifest.dependencies?.['@angular/elements'] === '22.0.7',
  'The packed package must own @angular/elements.',
);
assert(
  manifest.dependencies?.['@angular/compiler'] === '22.0.7',
  'The packed package must own its non-Angular-host JIT fallback.',
);
for (const dependency of [
  ...Object.values(manifest.dependencies ?? {}),
  ...Object.values(manifest.peerDependencies ?? {}),
]) {
  assert(
    typeof dependency === 'string' &&
      !/^(?:workspace:|file:)/u.test(dependency),
    'Packed dependencies must not contain workspace: or file: references.',
  );
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const inspectionResult = spawnSync(
  npm,
  ['pack', '--dry-run', '--json', archivePath],
  {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
if (inspectionResult.error) throw inspectionResult.error;
if (inspectionResult.status !== 0) {
  throw new Error(
    `npm pack inspection failed: ${inspectionResult.stderr || inspectionResult.stdout}`,
  );
}
const inspection = JSON.parse(inspectionResult.stdout);
assert(
  Array.isArray(inspection) && inspection.length === 1,
  'npm pack must inspect exactly one tarball.',
);
const [packed] = inspection;
const integrity = `sha512-${createHash('sha512')
  .update(readFileSync(archivePath))
  .digest('base64')}`;
assert(packed.name === manifest.name, 'Tarball name identity differs.');
assert(packed.version === manifest.version, 'Tarball version identity differs.');
assert(packed.integrity === integrity, 'Tarball integrity differs from its bytes.');

const files = new Set(
  (packed.files ?? []).map((file: { path?: string }) => file.path),
);
assert(files.has('LICENSE'), 'Tarball is missing LICENSE.');
assert(files.has('README.md'), 'Tarball is missing README.md.');
assert(
  [...files].some((file) => typeof file === 'string' && file.endsWith('.d.ts')),
  'Tarball is missing typings.',
);
assert(
  [...files].some(
    (file) =>
      typeof file === 'string' &&
      file.startsWith('fesm2022/') &&
      file.endsWith('.mjs'),
  ),
  'Tarball is missing FESM output.',
);

process.stdout.write(
  `Packed package contract verified: ${archiveName} (${packed.size} bytes).\n`,
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
