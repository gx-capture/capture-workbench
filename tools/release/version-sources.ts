import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const workspaceRoot = resolve(import.meta.dirname, '../..');

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const API_VERSION_PATTERN = /^\d+\.\d+$/u;
const SCHEMA_VERSION_PATTERN = /^\d+$/u;

export interface ReleaseIntent {
  releaseVersion: string;
  runtimeApiVersion: string;
  documentSchemaVersion: string;
}

export interface VersionEntry {
  label: string;
  value: string | undefined;
}

function text(root: string, relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function json(root: string, relativePath: string): Record<string, unknown> {
  return JSON.parse(text(root, relativePath)) as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function matchOne(content: string, expression: RegExp): string | undefined {
  return content.match(expression)?.[1];
}

function matchAll(content: string, expression: RegExp): string[] {
  return [...content.matchAll(expression)].map((match) => match[1]);
}

function fieldValues(value: unknown, key: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => fieldValues(item, key));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([name, item]) => [
    ...(name === key && typeof item === 'string' ? [item] : []),
    ...fieldValues(item, key),
  ]);
}

export function loadReleaseIntent(root = workspaceRoot): ReleaseIntent {
  const intent = json(root, 'release/version.json');
  const releaseVersion = stringValue(intent.releaseVersion);
  const runtimeApiVersion = stringValue(intent.runtimeApiVersion);
  const documentSchemaVersion = stringValue(intent.documentSchemaVersion);
  if (!releaseVersion || !RELEASE_VERSION_PATTERN.test(releaseVersion)) {
    throw new Error('release/version.json has an invalid releaseVersion.');
  }
  if (!runtimeApiVersion || !API_VERSION_PATTERN.test(runtimeApiVersion)) {
    throw new Error('release/version.json has an invalid runtimeApiVersion.');
  }
  if (
    !documentSchemaVersion ||
    !SCHEMA_VERSION_PATTERN.test(documentSchemaVersion)
  ) {
    throw new Error(
      'release/version.json has an invalid documentSchemaVersion.',
    );
  }
  return { releaseVersion, runtimeApiVersion, documentSchemaVersion };
}

function add(entries: VersionEntry[], label: string, value: unknown): void {
  entries.push({ label, value: stringValue(value) });
}

function addRegex(
  entries: VersionEntry[],
  label: string,
  content: string,
  expression: RegExp,
): void {
  add(entries, label, matchOne(content, expression));
}

function addRegexAll(
  entries: VersionEntry[],
  label: string,
  content: string,
  expression: RegExp,
): void {
  const values = matchAll(content, expression);
  if (values.length === 0) {
    add(entries, label, undefined);
    return;
  }
  values.forEach((value, index) =>
    add(entries, `${label} #${index + 1}`, value),
  );
}

export function collectReleaseVersionEntries(
  root = workspaceRoot,
): VersionEntry[] {
  const entries: VersionEntry[] = [];
  const packagePaths = [
    ['Capture Workbench package', 'packages/capture-angular/package.json'],
    [
      'Capture contracts TypeScript package',
      'packages/capture-contracts/package.json',
    ],
    [
      'Capture structuring TypeScript package',
      'packages/capture-structuring/package.json',
    ],
  ] as const;
  for (const [label, path] of packagePaths)
    add(entries, label, json(root, path).version);

  const tomlPaths = [
    [
      'Capture contracts Python wheel',
      'packages/capture-contracts/python/pyproject.toml',
    ],
    [
      'Capture structuring Python wheel',
      'packages/capture-structuring-python/pyproject.toml',
    ],
    ['Python runtime package', 'packages/capture-runtime/pyproject.toml'],
    [
      'Capture sidecar launcher crate',
      'packages/capture-sidecar-launcher/Cargo.toml',
    ],
    [
      'Deterministic runtime crate',
      'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.toml',
    ],
    ['Tauri crate', 'apps/capture-workbench-desktop/src-tauri/Cargo.toml'],
  ] as const;
  for (const [label, path] of tomlPaths) {
    addRegex(entries, label, text(root, path), /^version\s*=\s*"([^"]+)"/mu);
  }

  add(
    entries,
    'Tauri application',
    json(root, 'apps/capture-workbench-desktop/src-tauri/tauri.conf.json')
      .version,
  );
  addRegex(
    entries,
    'Python runtime constant',
    text(
      root,
      'packages/capture-runtime/src/capture_runtime/constants/versions.py',
    ),
    /^RUNTIME_VERSION:\s*Final\s*=\s*"([^"]+)"/mu,
  );
  addRegex(
    entries,
    'Deterministic runtime constant',
    text(
      root,
      'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/src/contract.rs',
    ),
    /^const RUNTIME_VERSION:\s*&str\s*=\s*"([^"]+)"/mu,
  );
  addRegex(
    entries,
    'Deterministic staging manifest',
    text(
      root,
      'apps/capture-workbench-desktop/scripts/stage-deterministic-runtime.ts',
    ),
    /runtimeVersion:\s*'([^']+)'/mu,
  );
  addRegex(
    entries,
    'Runtime staging expectation',
    text(root, 'apps/capture-workbench-desktop/scripts/stage-runtime.ts'),
    /runtimeVersion:\s*'([^']+)'/mu,
  );
  addRegex(
    entries,
    'Model source lock Python constant',
    text(root, 'packages/capture-runtime/scripts/model_source_lock.py'),
    /^RELEASE_VERSION\s*=\s*"([^"]+)"/mu,
  );
  addRegex(
    entries,
    'Commit A fixture Python constant',
    text(
      root,
      'packages/capture-runtime/scripts/generate_commit_a_fixtures.py',
    ),
    /^RELEASE_VERSION:\s*Final\s*=\s*"([^"]+)"/mu,
  );
  addRegex(
    entries,
    'Real model smoke release constant',
    text(
      root,
      'apps/capture-workbench-desktop/scripts/real-media-model-smoke.ts',
    ),
    /^export const REAL_MODEL_RELEASE_VERSION\s*=\s*'([^']+)'/mu,
  );
  addRegexAll(
    entries,
    'Runtime project engine archive version',
    text(root, 'packages/capture-runtime/project.json'),
    /capture-engine-(?:ocr|whisper)-([0-9.]+)-windows-x64/giu,
  );
  addRegex(
    entries,
    'Example runtime manifest',
    text(
      root,
      'apps/capture-workbench-desktop/src-tauri/resources/capture-runtime-manifest.example.json',
    ),
    /"runtimeVersion"\s*:\s*"([^"]+)"/u,
  );

  const sourceLock = json(
    root,
    'packages/capture-runtime/model-sources/release-model-source-lock.json',
  );
  add(
    entries,
    'Direct-model source lock releaseVersion',
    sourceLock.releaseVersion,
  );
  fieldValues(sourceLock, 'artifactVersion').forEach((value, index) =>
    add(
      entries,
      `Direct-model source lock artifactVersion #${index + 1}`,
      value,
    ),
  );

  const engineCatalog = json(
    root,
    'packages/capture-runtime/src/capture_runtime/assets/engine-catalog.json',
  );
  add(
    entries,
    'Embedded engine catalog runtimeVersion',
    engineCatalog.runtimeVersion,
  );
  fieldValues(engineCatalog, 'artifactVersion').forEach((value, index) =>
    add(
      entries,
      `Embedded engine catalog artifactVersion #${index + 1}`,
      value,
    ),
  );

  const generatedManifests = [
    [
      'Generated TypeScript contract packageVersion',
      'packages/capture-contracts/src/generated/contract-manifest.json',
      'packageVersion',
    ],
    [
      'Generated TypeScript contract runtimeVersion',
      'packages/capture-contracts/src/generated/contract-manifest.json',
      'runtimeVersion',
    ],
    [
      'Generated Python contract packageVersion',
      'packages/capture-contracts/python/src/capture_contracts/contract-manifest.json',
      'packageVersion',
    ],
    [
      'Generated Python contract runtimeVersion',
      'packages/capture-contracts/python/src/capture_contracts/contract-manifest.json',
      'runtimeVersion',
    ],
  ] as const;
  for (const [label, path, key] of generatedManifests)
    add(entries, label, json(root, path)[key]);

  addRegex(
    entries,
    'Generated TypeScript runtime constant',
    text(root, 'packages/capture-contracts/src/generated/contracts.ts'),
    /export const RUNTIME_VERSION\s*=\s*["']([^"']+)["']/u,
  );
  addRegexAll(
    entries,
    'Generated Python runtime version',
    text(
      root,
      'packages/capture-contracts/python/src/capture_contracts/generated_models.py',
    ),
    /(?:RUNTIME_VERSION\s*=\s*|runtime_version:\s*Literal\[)["']([^"']+)["']/gu,
  );
  addRegex(
    entries,
    'Canonical runtime contract literal',
    text(
      root,
      'packages/capture-runtime/src/capture_runtime/contracts/__init__.py',
    ),
    /runtime_version:\s*Literal\["([^"]+)"\]/u,
  );

  for (const path of [
    'packages/capture-sidecar-launcher/src/health.rs',
    'packages/capture-sidecar-launcher/src/manifest.rs',
    'packages/capture-sidecar-launcher/src/lib.rs',
    'apps/capture-workbench-desktop/src-tauri/src/config.rs',
    'apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs',
  ]) {
    addRegexAll(
      entries,
      `${path} release literals`,
      text(root, path),
      /"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)"/gu,
    );
  }
  return entries;
}

export function verifyGeneratedVersions(
  root = workspaceRoot,
  requestedVersion?: string,
): ReleaseIntent {
  const intent = loadReleaseIntent(root);
  if (requestedVersion && requestedVersion !== intent.releaseVersion) {
    throw new Error(
      `Requested release ${requestedVersion} differs from release/version.json (${intent.releaseVersion}).`,
    );
  }
  const mismatches = collectReleaseVersionEntries(root).filter(
    (entry) => entry.value !== intent.releaseVersion,
  );
  const constants = text(
    root,
    'packages/capture-runtime/src/capture_runtime/constants/versions.py',
  );
  const apiVersion = matchOne(
    constants,
    /^API_VERSION:\s*Final\s*=\s*"([^"]+)"/mu,
  );
  const schemaVersion = matchOne(
    constants,
    /^CAPTURE_DOCUMENT_SCHEMA_VERSION:\s*Final\s*=\s*"([^"]+)"/mu,
  );
  if (apiVersion !== intent.runtimeApiVersion) {
    mismatches.push({ label: 'Runtime API version', value: apiVersion });
  }
  if (schemaVersion !== intent.documentSchemaVersion) {
    mismatches.push({ label: 'Document schema version', value: schemaVersion });
  }
  const sourceLock = json(
    root,
    'packages/capture-runtime/model-sources/release-model-source-lock.json',
  );
  if (sourceLock.lockVersion !== '2') {
    throw new Error('Direct-model source lock must use lockVersion 2.');
  }
  if (mismatches.length > 0) {
    const detail = mismatches
      .map((entry) => `${entry.label}: ${entry.value ?? '<missing>'}`)
      .join('\n- ');
    throw new Error(
      `Generated release versions are not synchronized:\n- ${detail}`,
    );
  }
  return intent;
}

export function replaceReleaseVersion(
  content: string,
  previous: string,
  next: string,
): string {
  const escaped = previous.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return content.replace(
    new RegExp(`(?<![0-9])${escaped}(?![0-9])`, 'gu'),
    next,
  );
}

export function assertRegularTextFile(path: string): void {
  if (!statSync(path).isFile())
    throw new Error(`Expected a regular file: ${path}`);
}
