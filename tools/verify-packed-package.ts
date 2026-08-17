import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageDirectory = resolve(
  process.argv[2] ?? 'dist/packages/capture-workbench-ui',
);
const archiveDirectory = resolve(process.argv[3] ?? 'dist/packs');
const manifest = JSON.parse(
  readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
);
const archiveName = `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`;
const archivePath = join(archiveDirectory, archiveName);

assert(
  manifest.name === '@gx-capture/capture-workbench-ui',
  'Unexpected package name.',
);
assert(manifest.version === '0.4.1', 'Unexpected package version.');
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
  'The packed package must own its non-Angular-host compiler fallback.',
);
assert(
  manifest.dependencies?.['@gx-capture/capture-runtime-client'] === '0.4.1',
  'The packed package must depend on the published capture-runtime-client version.',
);
assert(
  manifest.module === 'loader.mjs' &&
    manifest.exports?.['.']?.default === './loader.mjs',
  'The packed package must route public imports through its compiler loader.',
);
assert(
  JSON.stringify(manifest.sideEffects) === JSON.stringify(['./loader.mjs']),
  'Only the package compiler loader may be marked side-effectful.',
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
assert(
  packed.version === manifest.version,
  'Tarball version identity differs.',
);
assert(
  packed.integrity === integrity,
  'Tarball integrity differs from its bytes.',
);

const files = new Set(
  (packed.files ?? []).map((file: { path?: string }) => file.path),
);
assert(files.has('LICENSE'), 'Tarball is missing LICENSE.');
assert(files.has('README.md'), 'Tarball is missing README.md.');
assert(files.has('loader.mjs'), 'Tarball is missing its compiler loader.');
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
const fesm = readFileSync(
  join(packageDirectory, 'fesm2022/gx-capture-capture-workbench-ui.mjs'),
  'utf8',
);
assert(
  /ɵɵngDeclare/u.test(fesm),
  'The published Angular library must retain partial compilation metadata.',
);
const loader = readFileSync(join(packageDirectory, 'loader.mjs'), 'utf8');
assert(
  loader ===
    "import '@angular/compiler';\nexport * from './fesm2022/gx-capture-capture-workbench-ui.mjs';\n",
  'The package compiler loader must initialize Angular before the FESM.',
);

process.stdout.write(
  `Packed package contract verified: ${archiveName} (${packed.size} bytes).\n`,
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
