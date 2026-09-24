import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type PackedPackageManifest = {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly contractSetSha256?: unknown;
  readonly dependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
};

/** Read the package.json stored inside a packed npm archive. */
export function inspectPackedPackageManifest(
  archivePath: string,
): PackedPackageManifest {
  const result = spawnSync(
    'tar',
    ['-xOf', archivePath, 'package/package.json'],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to inspect packed package ${archivePath}.`);
  }
  try {
    return JSON.parse(result.stdout) as PackedPackageManifest;
  } catch (error) {
    throw new Error(
      `Packed package manifest is not valid JSON: ${archivePath}.`,
      { cause: error },
    );
  }
}

export function assertPackedPackageIdentity(
  manifest: PackedPackageManifest,
  expected: {
    readonly name: string;
    readonly version: string;
    readonly contractSetSha256: string;
    readonly requireContractSetSha256?: boolean;
  },
): void {
  if (manifest.name !== expected.name) {
    throw new Error(
      `Packed package name differs: expected ${expected.name}, received ${String(manifest.name)}.`,
    );
  }
  if (manifest.version !== expected.version) {
    throw new Error(
      `Packed package ${expected.name} has the wrong version: expected ${expected.version}, received ${String(manifest.version)}.`,
    );
  }
  if (
    manifest.contractSetSha256 !== undefined &&
    typeof manifest.contractSetSha256 !== 'string'
  ) {
    throw new Error(
      `Packed package ${expected.name} contract-set SHA-256 metadata is invalid.`,
    );
  }
  if (
    expected.requireContractSetSha256 &&
    typeof manifest.contractSetSha256 !== 'string'
  ) {
    throw new Error(
      `Packed package ${expected.name} is missing contract-set SHA-256 metadata.`,
    );
  }
  if (
    typeof manifest.contractSetSha256 === 'string' &&
    manifest.contractSetSha256 !== expected.contractSetSha256
  ) {
    throw new Error(
      `Packed package ${expected.name} contract-set SHA-256 differs from candidate canonical contract: expected ${expected.contractSetSha256}, received ${manifest.contractSetSha256}.`,
    );
  }
}

export function verifyPackedPackage(): void {
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
  assert(manifest.version === '0.4.2', 'Unexpected package version.');
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
    manifest.dependencies?.['@gx-capture/capture-runtime-client'] === '0.4.2',
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
  assert(
    manifest.contractSetSha256 === undefined ||
      typeof manifest.contractSetSha256 === 'string',
    'Package contract-set metadata is invalid.',
  );
  const packedManifest = inspectPackedPackageManifest(archivePath);
  assertPackedPackageIdentity(packedManifest, {
    name: manifest.name,
    version: manifest.version,
    contractSetSha256: manifest.contractSetSha256 ?? '',
  });

  const files = new Set(
    (packed.files ?? []).map((file: { path?: string }) => file.path),
  );
  assert(files.has('LICENSE'), 'Tarball is missing LICENSE.');
  assert(files.has('README.md'), 'Tarball is missing README.md.');
  assert(files.has('loader.mjs'), 'Tarball is missing its compiler loader.');
  assert(
    [...files].some(
      (file) => typeof file === 'string' && file.endsWith('.d.ts'),
    ),
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
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    verifyPackedPackage();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
