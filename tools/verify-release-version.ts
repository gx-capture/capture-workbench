import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const rawArguments = process.argv.slice(2);
const positionalArguments =
  rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
if (positionalArguments.length > 1) {
  throw new Error('Pass one release tag such as v0.3.0.');
}
const requestedTag = positionalArguments[0] ?? process.env.GITHUB_REF_NAME;

if (!requestedTag) {
  throw new Error('Pass a release tag such as v0.3.0.');
}

const releaseVersion = requestedTag.startsWith('v')
  ? requestedTag.slice(1)
  : requestedTag;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  throw new Error(`Unsupported release tag: ${requestedTag}`);
}

const read = (relativePath) =>
  readFileSync(resolve(root, relativePath), 'utf8');
const jsonVersion = (relativePath) => JSON.parse(read(relativePath)).version;
const tomlVersion = (relativePath) =>
  read(relativePath).match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const pythonVersion = read(
  'packages/capture-runtime/src/capture_runtime/constants/versions.py',
).match(/^RUNTIME_VERSION:\s*Final\s*=\s*"([^"]+)"/m)?.[1];
const deterministicRuntimeVersion = read(
  'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/src/contract.rs',
).match(/^const RUNTIME_VERSION:\s*&str\s*=\s*"([^"]+)"/m)?.[1];
const deterministicStageVersion = read(
  'apps/capture-workbench-desktop/scripts/stage-deterministic-runtime.ts',
).match(/runtimeVersion:\s*'([^']+)'/m)?.[1];
const sourceLock = JSON.parse(
  read('packages/capture-runtime/model-sources/release-model-source-lock.json'),
);
const engineCatalog = JSON.parse(
  read('packages/capture-runtime/src/capture_runtime/assets/engine-catalog.json'),
);

const versions = new Map([
  ['Capture Workbench package', jsonVersion('packages/capture-angular/package.json')],
  [
    'Capture contracts TypeScript package',
    jsonVersion('packages/capture-contracts/package.json'),
  ],
  [
    'Capture contracts Python wheel',
    tomlVersion('packages/capture-contracts/python/pyproject.toml'),
  ],
  [
    'Capture structuring TypeScript package',
    jsonVersion('packages/capture-structuring/package.json'),
  ],
  [
    'Capture structuring Python wheel',
    tomlVersion('packages/capture-structuring-python/pyproject.toml'),
  ],
  [
    'Python runtime package',
    tomlVersion('packages/capture-runtime/pyproject.toml'),
  ],
  ['Python runtime constant', pythonVersion],
  [
    'Deterministic runtime crate',
    tomlVersion(
      'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.toml',
    ),
  ],
  ['Deterministic runtime constant', deterministicRuntimeVersion],
  ['Deterministic staging manifest', deterministicStageVersion],
  ['Direct-model source lock', sourceLock.releaseVersion],
  ['Embedded engine catalog', engineCatalog.runtimeVersion],
  [
    'Tauri crate',
    tomlVersion('apps/capture-workbench-desktop/src-tauri/Cargo.toml'),
  ],
  [
    'Tauri application',
    jsonVersion('apps/capture-workbench-desktop/src-tauri/tauri.conf.json'),
  ],
]);

if (sourceLock.lockVersion !== '2') {
  throw new Error('Direct-model source lock must use lockVersion 2.');
}

const mismatches = [...versions].filter(
  ([, version]) => version !== releaseVersion,
);
if (mismatches.length) {
  const detail = mismatches
    .map(([artifact, version]) => `${artifact}: ${version ?? '<missing>'}`)
    .join('\n- ');
  throw new Error(`Release ${requestedTag} is not synchronized:\n- ${detail}`);
}

process.stdout.write(
  `Release versions are synchronized at ${releaseVersion}.\n`,
);
