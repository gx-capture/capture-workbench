import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const workspaceRoot = resolve(import.meta.dirname, '../..');

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const API_VERSION_PATTERN = /^\d+\.\d+$/u;
const SCHEMA_VERSION_PATTERN = /^\d+$/u;
const EXPECTED_RELEASE_VERSION = '0.4.2';
const EXPECTED_RUNTIME_API_VERSION = '2.0';
const EXPECTED_DOCUMENT_SCHEMA_VERSION = '2';
const EXPECTED_CONTRACT_SET_VERSION = '2';
const EXPECTED_NX_VERSION = '23.1.2';
const EXPECTED_PROJECTION_SCHEMA_VERSION = '3';
const EXPECTED_CONTRACT_SET_SHA256 =
  'd293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40';
const EXPECTED_REPOSITORY = 'https://github.com/gx-capture/capture-workbench';
const EXPECTED_GIT_REPOSITORY =
  'git+https://github.com/gx-capture/capture-workbench.git';
const EXPECTED_NPM_REGISTRY = 'https://npm.pkg.github.com';
const EXPECTED_PYPI_PROJECT = 'capture-runtime-client';
const EXPECTED_PYPI_WORKFLOW_URL =
  'https://pypi.org/pypi/${project}/${version}/json';
const EXPECTED_MAVEN_REPOSITORY =
  'https://maven.pkg.github.com/gx-capture/capture-workbench';
const EXPECTED_MAVEN_WORKFLOW_REPOSITORY =
  'https://maven.pkg.github.com/gx-capture/capture-workbench/com/gx/capture/capture-runtime-client/${{ inputs.release_version }}';
const EXPECTED_CRATES_REGISTRY = 'https://crates.io/api/v1/crates';

const CONTRACT_HASH_PATHS = [
  [
    'contract.asset.runtime.sha256',
    'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
  ],
  [
    'contract.asset.typescript.sha256',
    'packages/capture-runtime-client/src/private/assets/contract-set.sha256',
  ],
  [
    'contract.asset.python.sha256',
    'packages/capture-runtime-client-python/src/capture_runtime_client/private/assets/contract-set.sha256',
  ],
  [
    'contract.asset.java.sha256',
    'packages/capture-runtime-client-java/src/main/resources/capture-runtime-contract-set.sha256',
  ],
] as const;

const CONTRACT_BUNDLE_PATHS = [
  [
    'contract.bundle.sha256',
    'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
  ],
  [
    'contract.bundle.typescript.sha256',
    'packages/capture-runtime-client/src/private/assets/contract-set.json',
  ],
  [
    'contract.bundle.python.sha256',
    'packages/capture-runtime-client-python/src/capture_runtime_client/private/assets/contract-set.json',
  ],
] as const;

const RELEASE_CHANNELS = [
  'npm-github-packages',
  'pypi',
  'maven-github-packages',
  'crates-io',
  'github-releases',
] as const;

const CHANNEL_OWNER_SPECS = [
  {
    channels: ['npm-github-packages'],
    role: 'publisher',
    workflowPath: '.github/workflows/_publish-npm.yml',
    orchestrators: ['.github/workflows/release-promote.yml'],
  },
  {
    channels: ['pypi'],
    role: 'publisher',
    workflowPath: '.github/workflows/_publish-pypi.yml',
    orchestrators: ['.github/workflows/runtime-promote.yml'],
  },
  {
    channels: ['maven-github-packages'],
    role: 'publisher',
    workflowPath: '.github/workflows/_publish-maven.yml',
    orchestrators: ['.github/workflows/release-promote.yml'],
  },
  {
    channels: ['crates-io'],
    role: 'publisher',
    workflowPath: '.github/workflows/_publish-crates.yml',
    orchestrators: [
      '.github/workflows/release-promote.yml',
      '.github/workflows/runtime-promote.yml',
    ],
  },
  {
    channels: ['github-releases'],
    role: 'publisher',
    workflowPath: '.github/workflows/_publish-github-release.yml',
    orchestrators: ['.github/workflows/release-promote.yml'],
  },
  {
    channels: ['github-releases'],
    role: 'publisher',
    workflowPath: '.github/workflows/_publish-runtime-github-release.yml',
    orchestrators: ['.github/workflows/runtime-promote.yml'],
  },
  {
    channels: RELEASE_CHANNELS,
    role: 'verifier',
    workflowPath: '.github/workflows/_verify-registries.yml',
    orchestrators: ['.github/workflows/release-promote.yml'],
  },
  {
    channels: ['github-releases'],
    role: 'ledger',
    workflowPath: '.github/workflows/_publish-promotion-ledger.yml',
    orchestrators: ['.github/workflows/release-promote.yml'],
  },
  {
    channels: ['github-releases'],
    role: 'pointer',
    workflowPath: '.github/workflows/_publish-stable-pointer.yml',
    orchestrators: ['.github/workflows/release-promote.yml'],
  },
] as const;

export interface ReleaseIntent {
  releaseVersion: string;
  runtimeApiVersion: string;
  documentSchemaVersion: string;
}

export interface VersionEntry {
  label: string;
  value: string | undefined;
}

export type InventoryKind =
  | 'release'
  | 'api'
  | 'document-schema'
  | 'projection'
  | 'contract-hash'
  | 'tooling'
  | 'channel';

export interface InventoryEntry {
  id: string;
  kind: InventoryKind;
  sourcePath: string;
  value: string;
}

export type ReleaseChannel =
  | 'npm-github-packages'
  | 'pypi'
  | 'maven-github-packages'
  | 'crates-io'
  | 'github-releases';

export type ChannelOwnerRole = 'publisher' | 'verifier' | 'ledger' | 'pointer';

export interface ChannelOwner {
  channels: readonly ReleaseChannel[];
  role: ChannelOwnerRole;
  workflowPath: string;
  orchestrators: readonly string[];
}

export interface ReleaseInventory {
  entries: readonly InventoryEntry[];
  channelOwners: readonly ChannelOwner[];
}

function text(root: string, relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function rejectDuplicateJsonKeys(content: string, sourcePath: string): void {
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < content.length && /\s/u.test(content[index])) index += 1;
  };

  const readStringToken = (): string => {
    const start = index;
    if (content[index] !== '"') {
      throw new Error(`Expected a JSON object key in ${sourcePath}.`);
    }
    index += 1;
    while (index < content.length) {
      const character = content[index];
      if (character === '\\') {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') return content.slice(start, index);
    }
    throw new Error(`Unterminated JSON string in ${sourcePath}.`);
  };

  const readValue = (path: readonly string[]): void => {
    skipWhitespace();
    const character = content[index];
    if (character === '"') {
      readStringToken();
      return;
    }
    if (character === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (content[index] === '}') {
        index += 1;
        return;
      }
      while (index < content.length) {
        skipWhitespace();
        const key = JSON.parse(readStringToken()) as string;
        if (keys.has(key)) {
          throw new Error(
            `Duplicate JSON key ${[...path, key].join('.')} in ${sourcePath}.`,
          );
        }
        keys.add(key);
        skipWhitespace();
        if (content[index] !== ':') {
          throw new Error(`Missing JSON colon for ${key} in ${sourcePath}.`);
        }
        index += 1;
        readValue([...path, key]);
        skipWhitespace();
        if (content[index] === '}') {
          index += 1;
          return;
        }
        if (content[index] !== ',') {
          throw new Error(`Missing JSON separator in ${sourcePath}.`);
        }
        index += 1;
      }
      throw new Error(`Unterminated JSON object in ${sourcePath}.`);
    }
    if (character === '[') {
      index += 1;
      skipWhitespace();
      let item = 0;
      if (content[index] === ']') {
        index += 1;
        return;
      }
      while (index < content.length) {
        readValue([...path, String(item++)]);
        skipWhitespace();
        if (content[index] === ']') {
          index += 1;
          return;
        }
        if (content[index] !== ',') {
          throw new Error(`Missing JSON array separator in ${sourcePath}.`);
        }
        index += 1;
      }
      throw new Error(`Unterminated JSON array in ${sourcePath}.`);
    }
    const start = index;
    while (
      index < content.length &&
      !/[\s,\]}]/u.test(content[index])
    ) {
      index += 1;
    }
    if (index === start) {
      throw new Error(`Missing JSON value in ${sourcePath}.`);
    }
  };

  readValue([]);
  skipWhitespace();
  if (index !== content.length) {
    throw new Error(`Trailing JSON content in ${sourcePath}.`);
  }
}

function json(root: string, relativePath: string): Record<string, unknown> {
  const content = text(root, relativePath);
  const parsed = JSON.parse(content) as Record<string, unknown>;
  rejectDuplicateJsonKeys(content, relativePath);
  return parsed;
}

function bytes(root: string, relativePath: string): Buffer {
  return readFileSync(resolve(root, relativePath));
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

function matchExactlyOne(
  content: string,
  expression: RegExp,
  label: string,
  sourcePath: string,
): string {
  const flags = expression.flags.includes('g')
    ? expression.flags
    : `${expression.flags}g`;
  const matches = [...content.matchAll(new RegExp(expression.source, flags))];
  if (matches.length !== 1 || !matches[0][1]) {
    throw new Error(
      `${label} must have exactly one value in ${sourcePath}; found ${matches.length}.`,
    );
  }
  return matches[0][1];
}

function matchCount(content: string, expression: RegExp): number {
  const flags = expression.flags.includes('g')
    ? expression.flags
    : `${expression.flags}g`;
  return [...content.matchAll(new RegExp(expression.source, flags))].length;
}

function addInventoryEntry(
  entries: InventoryEntry[],
  id: string,
  kind: InventoryKind,
  sourcePath: string,
  value: unknown,
): void {
  if (entries.some((entry) => entry.id === id)) {
    throw new Error(`Duplicate inventory identity: ${id}.`);
  }
  const string = stringValue(value);
  if (!string) throw new Error(`Missing inventory identity ${id} in ${sourcePath}.`);
  entries.push({ id, kind, sourcePath, value: string });
}

function addExactInventoryMatch(
  entries: InventoryEntry[],
  id: string,
  kind: InventoryKind,
  root: string,
  sourcePath: string,
  expression: RegExp,
): string {
  const value = matchExactlyOne(
    text(root, sourcePath),
    expression,
    id,
    sourcePath,
  );
  addInventoryEntry(entries, id, kind, sourcePath, value);
  return value;
}

function jsonString(
  root: string,
  sourcePath: string,
  key: string,
  id: string,
): string {
  const value = stringValue(json(root, sourcePath)[key]);
  if (!value) throw new Error(`Missing inventory identity ${id} in ${sourcePath}.`);
  return value;
}

function strictHash(root: string, sourcePath: string, id: string): string {
  const value = text(root, sourcePath);
  if (!/^[0-9a-f]{64}\n?$/u.test(value)) {
    throw new Error(`Missing or malformed contract hash ${id} in ${sourcePath}.`);
  }
  return value.trim();
}

function nestedString(value: unknown, keys: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return stringValue(current);
}

function addNestedInventoryEntry(
  entries: InventoryEntry[],
  id: string,
  kind: InventoryKind,
  sourcePath: string,
  value: unknown,
  keys: readonly string[],
): void {
  addInventoryEntry(entries, id, kind, sourcePath, nestedString(value, keys));
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

interface LockEntry {
  key: string;
  dependencies: readonly [string, string][];
}

function unquoteYamlKey(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseYamlMapping(line: string): [string, string] | undefined {
  const match = line.match(
    /^\s{6}(?:'([^']+)'|"([^"]+)"|([^:]+)):\s*(.*?)\s*$/u,
  );
  if (!match) return undefined;
  return [match[1] ?? match[2] ?? match[3].trim(), match[4]];
}

function parseLockSection(lock: string, section: 'packages' | 'snapshots'): LockEntry[] {
  const lines = lock.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => line === `${section}:`);
  if (sectionIndex < 0) throw new Error(`Missing ${section} section in pnpm-lock.yaml.`);
  const entries: LockEntry[] = [];
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z][^:]*:\s*$/u.test(line)) break;
    const entryMatch = line.match(/^\x20{2}(?:'([^']+)'|"([^"]+)"|([^:\s][^:]*)):\s*(.*)$/u);
    if (!entryMatch) continue;
    const key = unquoteYamlKey(entryMatch[1] ?? entryMatch[2] ?? entryMatch[3]);
    const dependencies: [string, string][] = [];
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child];
      if (/^\x20{2}(?:'[^']+'|"[^"]+"|[^:\s][^:]*):\s*/u.test(childLine)) break;
      if (/^\x20{4}(?:dependencies|optionalDependencies):\s*$/u.test(childLine)) {
        for (let dependencyLine = child + 1; dependencyLine < lines.length; dependencyLine += 1) {
          const dependency = parseYamlMapping(lines[dependencyLine]);
          if (dependency) {
            dependencies.push(dependency);
            continue;
          }
          if (
            lines[dependencyLine].trim() !== '' &&
            !/^\s{6}/u.test(lines[dependencyLine])
          ) {
            break;
          }
        }
      }
    }
    entries.push({ key, dependencies });
  }
  if (entries.length === 0) throw new Error(`Missing entries in ${section} section of pnpm-lock.yaml.`);
  return entries;
}

function parseImporterReferences(lock: string): readonly [string, string][] {
  const lines = lock.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => line === 'importers:');
  if (sectionIndex < 0) throw new Error('Missing importers section in pnpm-lock.yaml.');
  const references: [string, string][] = [];
  let inDependencySection = false;
  let dependency: string | undefined;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === 'packages:') break;
    if (/^\x20{2}[^\s]/u.test(line)) {
      inDependencySection = false;
      dependency = undefined;
      continue;
    }
    if (/^\x20{4}(?:dependencies|devDependencies|optionalDependencies|peerDependencies):\s*$/u.test(line)) {
      inDependencySection = true;
      dependency = undefined;
      continue;
    }
    if (!inDependencySection) continue;
    const dependencyMatch = line.match(
      /^\s{6}(?:'([^']+)'|"([^"]+)"|([^:\s][^:]*)):\s*$/u,
    );
    if (dependencyMatch) {
      dependency = dependencyMatch[1] ?? dependencyMatch[2] ?? dependencyMatch[3];
      continue;
    }
    const versionMatch = line.match(/^\s{8}version:\s*(.*?)\s*$/u);
    if (versionMatch && dependency) {
      references.push([dependency, versionMatch[1]]);
      dependency = undefined;
    }
  }
  return references;
}

function withoutPeerSuffix(key: string): string {
  const peerStart = key.indexOf('(');
  return peerStart < 0 ? key : key.slice(0, peerStart);
}

function assertPnpmLockGraphClosed(lock: string, sourcePath: string): void {
  if (!/^lockfileVersion:\s*['"]?9\.0['"]?\s*$/mu.test(lock)) {
    throw new Error(`Unsupported pnpm lockfile version in ${sourcePath}.`);
  }
  const packages = parseLockSection(lock, 'packages');
  const snapshots = parseLockSection(lock, 'snapshots');
  const packageBaseKeys = new Set(packages.map((entry) => withoutPeerSuffix(entry.key)));
  const snapshotKeys = new Set(snapshots.map((entry) => entry.key));
  const snapshotBaseKeys = new Set(snapshots.map((entry) => withoutPeerSuffix(entry.key)));
  const assertReference = (dependency: string, reference: string, owner: string): void => {
    const value = unquoteYamlKey(reference);
    if (
      value === '' ||
      value.startsWith('workspace:') ||
      value.startsWith('link:') ||
      value.startsWith('file:') ||
      value.startsWith('catalog:') ||
      value.startsWith('patch:') ||
      value === '*' ||
      value === '^' ||
      value === '~'
    ) return;
    const snapshotKey = `${dependency}@${value}`;
    const packageBase = withoutPeerSuffix(snapshotKey);
    if (!packageBaseKeys.has(packageBase) || !snapshotKeys.has(snapshotKey)) {
      throw new Error(
        `Missing pnpm package/snapshot for ${dependency}@${value} referenced by ${owner} in ${sourcePath}.`,
      );
    }
  };
  for (const entry of packages) {
    if (!snapshotBaseKeys.has(entry.key)) {
      throw new Error(`Missing pnpm snapshot for package ${entry.key} in ${sourcePath}.`);
    }
  }
  for (const entry of snapshots) {
    for (const [dependency, reference] of entry.dependencies) {
      assertReference(dependency, reference, entry.key);
    }
  }
  for (const [dependency, reference] of parseImporterReferences(lock)) {
    assertReference(dependency, reference, 'importer');
  }
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
    ['Capture Workbench package', 'packages/capture-workbench-ui/package.json'],
    [
      'Capture Runtime client TypeScript package',
      'packages/capture-runtime-client/package.json',
    ],
  ] as const;
  for (const [label, path] of packagePaths)
    add(entries, label, json(root, path).version);

  const tomlPaths = [
    [
      'Capture Runtime client Python wheel',
      'packages/capture-runtime-client-python/pyproject.toml',
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
    'Java runtime client POM',
    text(root, 'packages/capture-runtime-client-java/pom.xml'),
    /<version>(\d+\.\d+\.\d+(?:-[^<]+)?)<\/version>/u,
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

function addJsonInventoryEntry(
  entries: InventoryEntry[],
  id: string,
  kind: InventoryKind,
  root: string,
  sourcePath: string,
  key: string,
): string {
  const value = jsonString(root, sourcePath, key, id);
  addInventoryEntry(entries, id, kind, sourcePath, value);
  return value;
}

function assertExpected(
  id: string,
  actual: string,
  expected: string,
  sourcePath: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${id} drifted in ${sourcePath}: expected ${expected}, found ${actual}.`,
    );
  }
}

function addExpectedMatch(
  entries: InventoryEntry[],
  id: string,
  kind: InventoryKind,
  root: string,
  sourcePath: string,
  expression: RegExp,
  expected: string,
): void {
  const value = addExactInventoryMatch(
    entries,
    id,
    kind,
    root,
    sourcePath,
    expression,
  );
  assertExpected(id, value, expected, sourcePath);
}

function addExpectedOccurrences(
  entries: InventoryEntry[],
  idPrefix: string,
  kind: InventoryKind,
  root: string,
  sourcePath: string,
  expression: RegExp,
  expected: string,
  count: number,
): void {
  const values = matchAll(text(root, sourcePath), expression);
  if (values.length !== count) {
    throw new Error(
      `${idPrefix} must have exactly ${count} values in ${sourcePath}; found ${values.length}.`,
    );
  }
  values.forEach((value, index) => {
    const id = `${idPrefix}.${index + 1}`;
    addInventoryEntry(entries, id, kind, sourcePath, value);
    assertExpected(id, value, expected, sourcePath);
  });
}

function addExpectedJson(
  entries: InventoryEntry[],
  id: string,
  kind: InventoryKind,
  root: string,
  sourcePath: string,
  key: string,
  expected: string,
): void {
  const value = addJsonInventoryEntry(entries, id, kind, root, sourcePath, key);
  assertExpected(id, value, expected, sourcePath);
}

function addExpectedNestedJson(
  entries: InventoryEntry[],
  id: string,
  kind: InventoryKind,
  root: string,
  sourcePath: string,
  value: unknown,
  keys: readonly string[],
  expected: string,
): void {
  addNestedInventoryEntry(entries, id, kind, sourcePath, value, keys);
  assertExpected(
    id,
    entries[entries.length - 1].value,
    expected,
    sourcePath,
  );
}

function addReleasePackageEntries(
  entries: InventoryEntry[],
  root: string,
): void {
  const packagePaths = [
    ['release.package.workbench-ui', 'packages/capture-workbench-ui/package.json'],
    ['release.package.runtime-client-ts', 'packages/capture-runtime-client/package.json'],
  ] as const;
  for (const [id, sourcePath] of packagePaths)
    addExpectedJson(entries, id, 'release', root, sourcePath, 'version', EXPECTED_RELEASE_VERSION);

  const tomlPaths = [
    ['release.package.runtime-client-python', 'packages/capture-runtime-client-python/pyproject.toml'],
    ['release.package.runtime', 'packages/capture-runtime/pyproject.toml'],
    ['release.package.sidecar', 'packages/capture-sidecar-launcher/Cargo.toml'],
    ['release.package.deterministic-runtime', 'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.toml'],
    ['release.package.desktop', 'apps/capture-workbench-desktop/src-tauri/Cargo.toml'],
  ] as const;
  for (const [id, sourcePath] of tomlPaths)
    addExpectedMatch(entries, id, 'release', root, sourcePath, /^version\s*=\s*"([^"]+)"/mu, EXPECTED_RELEASE_VERSION);

  addExpectedJson(
    entries,
    'release.package.tauri-application',
    'release',
    root,
    'apps/capture-workbench-desktop/src-tauri/tauri.conf.json',
    'version',
    EXPECTED_RELEASE_VERSION,
  );
  addExpectedMatch(
    entries,
    'release.source.java-client',
    'release',
    root,
    'packages/capture-runtime-client-java/pom.xml',
    /^\s{2}<version>(\d+\.\d+\.\d+(?:-[^<]+)?)<\/version>/mu,
    EXPECTED_RELEASE_VERSION,
  );
}

function addReleaseSourceEntries(
  entries: InventoryEntry[],
  root: string,
): void {
  addExpectedMatch(
    entries,
    'release.version',
    'release',
    root,
    'release/version.json',
    /"releaseVersion"\s*:\s*"([^"]+)"/u,
    EXPECTED_RELEASE_VERSION,
  );
  addReleasePackageEntries(entries, root);
  addExpectedMatch(
    entries,
    'runtime.version.source',
    'release',
    root,
    'packages/capture-runtime/src/capture_runtime/constants/versions.py',
    /^RUNTIME_VERSION:\s*Final\s*=\s*"([^"]+)"/mu,
    EXPECTED_RELEASE_VERSION,
  );
  addExpectedMatch(
    entries,
    'runtime.api',
    'api',
    root,
    'packages/capture-runtime/src/capture_runtime/constants/versions.py',
    /^API_VERSION:\s*Final\s*=\s*"([^"]+)"/mu,
    EXPECTED_RUNTIME_API_VERSION,
  );
  addExpectedMatch(
    entries,
    'document.schema',
    'document-schema',
    root,
    'packages/capture-runtime/src/capture_runtime/constants/versions.py',
    /^CAPTURE_DOCUMENT_SCHEMA_VERSION:\s*Final\s*=\s*"([^"]+)"/mu,
    EXPECTED_DOCUMENT_SCHEMA_VERSION,
  );
  addExpectedMatch(
    entries,
    'release.model-source-script',
    'release',
    root,
    'packages/capture-runtime/scripts/model_source_lock.py',
    /^RELEASE_VERSION\s*=\s*"([^"]+)"/mu,
    EXPECTED_RELEASE_VERSION,
  );
  addExpectedMatch(
    entries,
    'release.model-source-fixture-generator',
    'release',
    root,
    'packages/capture-runtime/scripts/generate_commit_a_fixtures.py',
    /^RELEASE_VERSION:\s*Final\s*=\s*"([^"]+)"/mu,
    EXPECTED_RELEASE_VERSION,
  );
  addExpectedMatch(
    entries,
    'release.deterministic-contract.runtime',
    'release',
    root,
    'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/src/contract.rs',
    /^const RUNTIME_VERSION:\s*&str\s*=\s*"([^"]+)"/mu,
    EXPECTED_RELEASE_VERSION,
  );
  addExpectedMatch(
    entries,
    'runtime.api.deterministic-contract',
    'api',
    root,
    'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/src/contract.rs',
    /^const API_VERSION:\s*&str\s*=\s*"([^"]+)"/mu,
    EXPECTED_RUNTIME_API_VERSION,
  );
  addExpectedMatch(
    entries,
    'document.schema.deterministic-contract',
    'document-schema',
    root,
    'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/src/contract.rs',
    /^const SCHEMA_VERSION:\s*&str\s*=\s*"([^"]+)"/mu,
    EXPECTED_DOCUMENT_SCHEMA_VERSION,
  );
  addExpectedOccurrences(
    entries,
    'release.engine-archive.ocr',
    'release',
    root,
    'packages/capture-runtime/project.json',
    /capture-engine-ocr-([0-9]+\.[0-9]+\.[0-9]+)-windows-x64/gu,
    EXPECTED_RELEASE_VERSION,
    7,
  );
  addExpectedOccurrences(
    entries,
    'release.engine-archive.whisper',
    'release',
    root,
    'packages/capture-runtime/project.json',
    /capture-engine-whisper-([0-9]+\.[0-9]+\.[0-9]+)-windows-x64/gu,
    EXPECTED_RELEASE_VERSION,
    7,
  );
  addExpectedOccurrences(
    entries,
    'runtime.version.sidecar-health',
    'release',
    root,
    'packages/capture-sidecar-launcher/src/health.rs',
    /runtime_version:\s*"([^"]+)"/gu,
    EXPECTED_RELEASE_VERSION,
    1,
  );
  addExpectedOccurrences(
    entries,
    'runtime.api.sidecar-health',
    'api',
    root,
    'packages/capture-sidecar-launcher/src/health.rs',
    /api_version:\s*"([^"]+)"/gu,
    EXPECTED_RUNTIME_API_VERSION,
    1,
  );
  addExpectedOccurrences(
    entries,
    'document.schema.sidecar-health',
    'document-schema',
    root,
    'packages/capture-sidecar-launcher/src/health.rs',
    /capture_document_schema_version:\s*"([^"]+)"/gu,
    EXPECTED_DOCUMENT_SCHEMA_VERSION,
    1,
  );
  addExpectedOccurrences(
    entries,
    'runtime.version.sidecar-manifest',
    'release',
    root,
    'packages/capture-sidecar-launcher/src/manifest.rs',
    /runtime_version:\s*"([^"]+)"/gu,
    EXPECTED_RELEASE_VERSION,
    2,
  );
  addExpectedOccurrences(
    entries,
    'runtime.api.sidecar-manifest',
    'api',
    root,
    'packages/capture-sidecar-launcher/src/manifest.rs',
    /api_version:\s*"([^"]+)"/gu,
    EXPECTED_RUNTIME_API_VERSION,
    2,
  );
  addExpectedOccurrences(
    entries,
    'document.schema.sidecar-manifest',
    'document-schema',
    root,
    'packages/capture-sidecar-launcher/src/manifest.rs',
    /capture_document_schema_version:\s*"([^"]+)"/gu,
    EXPECTED_DOCUMENT_SCHEMA_VERSION,
    2,
  );
  addExpectedOccurrences(
    entries,
    'runtime.version.sidecar-lib',
    'release',
    root,
    'packages/capture-sidecar-launcher/src/lib.rs',
    /runtime_version:\s*"([^"]+)"/gu,
    EXPECTED_RELEASE_VERSION,
    1,
  );
  addExpectedOccurrences(
    entries,
    'runtime.api.sidecar-lib',
    'api',
    root,
    'packages/capture-sidecar-launcher/src/lib.rs',
    /api_version:\s*"([^"]+)"/gu,
    EXPECTED_RUNTIME_API_VERSION,
    1,
  );
  addExpectedOccurrences(
    entries,
    'document.schema.sidecar-lib',
    'document-schema',
    root,
    'packages/capture-sidecar-launcher/src/lib.rs',
    /capture_document_schema_version:\s*"([^"]+)"/gu,
    EXPECTED_DOCUMENT_SCHEMA_VERSION,
    1,
  );
  addExpectedOccurrences(
    entries,
    'runtime.version.desktop-config',
    'release',
    root,
    'apps/capture-workbench-desktop/src-tauri/src/config.rs',
    /runtime_version:\s*"([^"]+)"/gu,
    EXPECTED_RELEASE_VERSION,
    2,
  );
  addExpectedOccurrences(
    entries,
    'runtime.api.desktop-config',
    'api',
    root,
    'apps/capture-workbench-desktop/src-tauri/src/config.rs',
    /api_version:\s*"([^"]+)"/gu,
    EXPECTED_RUNTIME_API_VERSION,
    2,
  );
  addExpectedOccurrences(
    entries,
    'document.schema.desktop-config',
    'document-schema',
    root,
    'apps/capture-workbench-desktop/src-tauri/src/config.rs',
    /capture_document_schema_version:\s*"([^"]+)"/gu,
    EXPECTED_DOCUMENT_SCHEMA_VERSION,
    2,
  );
  addExpectedOccurrences(
    entries,
    'runtime.version.desktop-client',
    'release',
    root,
    'apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs',
    /runtime_version:\s*"([^"]+)"/gu,
    EXPECTED_RELEASE_VERSION,
    5,
  );
  addExpectedOccurrences(
    entries,
    'runtime.api.desktop-client',
    'api',
    root,
    'apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs',
    /api_version:\s*"([^"]+)"/gu,
    EXPECTED_RUNTIME_API_VERSION,
    5,
  );
  addExpectedOccurrences(
    entries,
    'document.schema.desktop-client',
    'document-schema',
    root,
    'apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs',
    /capture_document_schema_version:\s*"([^"]+)"/gu,
    EXPECTED_DOCUMENT_SCHEMA_VERSION,
    5,
  );

  const sourceLockPath = 'packages/capture-runtime/model-sources/release-model-source-lock.json';
  const sourceLock = json(root, sourceLockPath);
  addNestedInventoryEntry(entries, 'release.model-source-lock', 'release', sourceLockPath, sourceLock, ['releaseVersion']);
  assertExpected('release.model-source-lock', entries[entries.length - 1].value, EXPECTED_RELEASE_VERSION, sourceLockPath);
  const sourceArtifacts = fieldValues(sourceLock, 'artifactVersion');
  if (sourceArtifacts.length === 0) throw new Error(`Missing artifactVersion identities in ${sourceLockPath}.`);
  sourceArtifacts.forEach((value, index) => {
    addInventoryEntry(entries, `release.model-source-artifact.${index + 1}`, 'release', sourceLockPath, value);
    assertExpected(`release.model-source-artifact.${index + 1}`, value, EXPECTED_RELEASE_VERSION, sourceLockPath);
  });
  addExpectedNestedJson(
    entries,
    'model-source-lock.version',
    'tooling',
    root,
    sourceLockPath,
    sourceLock,
    ['lockVersion'],
    '2',
  );

  const catalogPath = 'packages/capture-runtime/src/capture_runtime/assets/engine-catalog.json';
  addExpectedJson(entries, 'release.engine-catalog', 'release', root, catalogPath, 'runtimeVersion', EXPECTED_RELEASE_VERSION);
  addExpectedJson(entries, 'engine-catalog.version', 'tooling', root, catalogPath, 'catalogVersion', '2');

  const profilePath = 'packages/capture-runtime/src/capture_runtime/assets/ocr-profile.json';
  addExpectedJson(entries, 'release.ocr-profile', 'release', root, profilePath, 'releaseVersion', EXPECTED_RELEASE_VERSION);
  addExpectedJson(entries, 'ocr-profile.version', 'tooling', root, profilePath, 'schemaVersion', '2');

  const contractSetPath = 'packages/capture-runtime/src/capture_runtime/assets/contract-set.json';
  addExpectedJson(entries, 'contract-set.version', 'tooling', root, contractSetPath, 'contractSetVersion', EXPECTED_CONTRACT_SET_VERSION);

  addExpectedJson(entries, 'release.desktop-manifest', 'release', root, 'apps/capture-workbench-desktop/src-tauri/resources/capture-runtime-manifest.json', 'runtimeVersion', EXPECTED_RELEASE_VERSION);
  addExpectedJson(entries, 'release.desktop-manifest-api', 'api', root, 'apps/capture-workbench-desktop/src-tauri/resources/capture-runtime-manifest.json', 'apiVersion', EXPECTED_RUNTIME_API_VERSION);
  addExpectedJson(entries, 'release.desktop-manifest-schema', 'document-schema', root, 'apps/capture-workbench-desktop/src-tauri/resources/capture-runtime-manifest.json', 'captureDocumentSchemaVersion', EXPECTED_DOCUMENT_SCHEMA_VERSION);
  addExpectedJson(entries, 'release.desktop-example-manifest', 'release', root, 'apps/capture-workbench-desktop/src-tauri/resources/capture-runtime-manifest.example.json', 'runtimeVersion', EXPECTED_RELEASE_VERSION);
  addExpectedJson(entries, 'release.desktop-stage', 'release', root, 'apps/capture-workbench-desktop/src-tauri/resources/.runtime-stage.json', 'runtimeVersion', EXPECTED_RELEASE_VERSION);
  addExpectedMatch(entries, 'release.deterministic-stage', 'release', root, 'apps/capture-workbench-desktop/scripts/stage-deterministic-runtime.ts', /runtimeVersion:\s*'([^']+)'/mu, EXPECTED_RELEASE_VERSION);
  addExpectedMatch(entries, 'release.runtime-stage', 'release', root, 'apps/capture-workbench-desktop/scripts/stage-runtime.ts', /runtimeVersion:\s*'([^']+)'/mu, EXPECTED_RELEASE_VERSION);
  addExpectedMatch(entries, 'release.real-model-smoke', 'release', root, 'apps/capture-workbench-desktop/scripts/real-media-model-smoke.ts', /^export const REAL_MODEL_RELEASE_VERSION\s*=\s*'([^']+)'/mu, EXPECTED_RELEASE_VERSION);
}

function addProjectionEntries(
  entries: InventoryEntry[],
  root: string,
): void {
  const sourcePath = 'packages/capture-runtime/src/capture_runtime/contracts/__init__.py';
  const sourceContent = text(root, sourcePath);
  if (matchCount(sourceContent, /^class CaptureOcrProjectionV3\b/gmu) !== 1)
    throw new Error(`duplicate projection declaration in ${sourcePath}.`);
  const sourceSchema = addExactInventoryMatch(
    entries,
    'ocr.projection.schema',
    'projection',
    root,
    sourcePath,
    /class CaptureOcrProjectionV3[\s\S]*?schema_version:\s*Literal\["([^"]+)"\]/u,
  );
  assertExpected('ocr.projection.schema', sourceSchema, EXPECTED_PROJECTION_SCHEMA_VERSION, sourcePath);

  const bundlePath = 'packages/capture-runtime/src/capture_runtime/assets/contract-set.json';
  const bundle = json(root, bundlePath);
  const schemas = bundle.schemas;
  if (!Array.isArray(schemas)) throw new Error(`Missing schemas array in ${bundlePath}.`);
  const projections = schemas.filter(
    (schema) =>
      schema &&
      typeof schema === 'object' &&
      (schema as Record<string, unknown>).name === 'CaptureOcrProjectionV3',
  );
  if (projections.length !== 1) {
    throw new Error(
      `CaptureOcrProjectionV3 must have exactly one canonical schema; found ${projections.length}.`,
    );
  }
  const bundleSchema = nestedString(projections[0], [
    'schema',
    'properties',
    'schemaVersion',
    'const',
  ]);
  if (!bundleSchema) throw new Error(`Missing projection schema version in ${bundlePath}.`);
  addInventoryEntry(entries, 'ocr.projection.schema.bundle', 'projection', bundlePath, bundleSchema);
  assertExpected('ocr.projection.schema.bundle', bundleSchema, sourceSchema, bundlePath);

  const generatedTsPath = 'packages/capture-runtime-client/src/private/generated-contracts.ts';
  const generatedTsContent = text(root, generatedTsPath);
  if (matchCount(generatedTsContent, /^export interface CaptureOcrProjectionV3\s*\{/gmu) !== 1)
    throw new Error(`duplicate projection declaration in ${generatedTsPath}.`);
  addExpectedMatch(entries, 'ocr.projection.schema.typescript', 'projection', root, generatedTsPath, /export interface CaptureOcrProjectionV3\s*\{[\s\S]*?readonly schemaVersion:\s*"([^"]+)";/u, EXPECTED_PROJECTION_SCHEMA_VERSION);
  const generatedPythonPath = 'packages/capture-runtime-client-python/src/capture_runtime_client/private/generated_models.py';
  const generatedPythonContent = text(root, generatedPythonPath);
  if (matchCount(generatedPythonContent, /^class CaptureOcrProjectionV3\b/gmu) !== 1)
    throw new Error(`duplicate projection declaration in ${generatedPythonPath}.`);
  addExpectedMatch(entries, 'ocr.projection.schema.python', 'projection', root, generatedPythonPath, /class CaptureOcrProjectionV3\b[\s\S]*?schema_version:\s*Literal\["([^"]+)"\]/u, EXPECTED_PROJECTION_SCHEMA_VERSION);
  addExpectedMatch(entries, 'document.schema.typescript-structured', 'document-schema', root, generatedTsPath, /export interface CaptureDocument\s*\{[\s\S]*?readonly schemaVersion:\s*"([^"]+)";/u, EXPECTED_DOCUMENT_SCHEMA_VERSION);
  addExpectedMatch(entries, 'document.schema.typescript-raw', 'document-schema', root, generatedTsPath, /export interface RawCapture\s*\{[\s\S]*?readonly schemaVersion:\s*"([^"]+)";/u, EXPECTED_DOCUMENT_SCHEMA_VERSION);
  addExpectedMatch(entries, 'document.schema.python-structured', 'document-schema', root, generatedPythonPath, /class CaptureDocument\b[\s\S]*?schema_version:\s*Literal\["([^"]+)"\]/u, EXPECTED_DOCUMENT_SCHEMA_VERSION);
  addExpectedMatch(entries, 'document.schema.python-raw', 'document-schema', root, generatedPythonPath, /class RawCapture\b[\s\S]*?schema_version:\s*Literal\["([^"]+)"\]/u, EXPECTED_DOCUMENT_SCHEMA_VERSION);

  const pythonSchemaPath = 'packages/capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-ocr-projection-v3.schema.json';
  const pythonSchema = json(root, pythonSchemaPath);
  addExpectedJson(entries, 'ocr.projection.schema.python-json-title', 'projection', root, pythonSchemaPath, 'title', 'CaptureOcrProjectionV3');
  addExpectedNestedJson(entries, 'ocr.projection.schema.python-json', 'projection', root, pythonSchemaPath, pythonSchema, ['properties', 'schemaVersion', 'const'], EXPECTED_PROJECTION_SCHEMA_VERSION);
  addExpectedMatch(entries, 'ocr.projection.schema.java', 'projection', root, 'packages/capture-runtime-client-java/src/main/java/com/gx/capture/runtime/client/CaptureRuntimeTypes.java', /BEGIN GENERATED OCR PROJECTION[\s\S]*?schemaVersion = ocrText\(schemaVersion, 1, 1, "schemaVersion"\); if \(!"([^"]+)"\.equals\(schemaVersion\)/u, EXPECTED_PROJECTION_SCHEMA_VERSION);
  addExpectedMatch(entries, 'runtime.version.java', 'release', root, 'packages/capture-runtime-client-java/src/main/java/com/gx/capture/runtime/client/CaptureRuntimeTypes.java', /OCR_RUNTIME_VERSION\s*=\s*"([^"]+)"/u, EXPECTED_RELEASE_VERSION);
  addExpectedMatch(entries, 'runtime.api.java', 'api', root, 'packages/capture-runtime-client-java/src/main/java/com/gx/capture/runtime/client/CaptureRuntimeTypes.java', /public static final String API_VERSION\s*=\s*"([^"]+)"/u, EXPECTED_RUNTIME_API_VERSION);
  addExpectedMatch(entries, 'document.schema.java', 'document-schema', root, 'packages/capture-runtime-client-java/src/main/java/com/gx/capture/runtime/client/CaptureRuntimeTypes.java', /public static final String PROTOCOL_VERSION\s*=\s*"([^"]+)"/u, EXPECTED_DOCUMENT_SCHEMA_VERSION);
  addExpectedOccurrences(entries, 'document.schema.java-raw', 'document-schema', root, 'packages/capture-runtime-client-java/src/main/java/com/gx/capture/runtime/client/CaptureRuntimeTypes.java', /if \(!"(2)"\.equals\(schemaVersion\)\)/gu, EXPECTED_DOCUMENT_SCHEMA_VERSION, 2);

  for (const [id, sourcePath] of [
    ['document.schema.python-json', 'packages/capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-document.schema.json'],
    ['document.schema.python-raw-json', 'packages/capture-runtime-client-python/src/capture_runtime_client/private/schemas/raw-capture.schema.json'],
    ['document.schema.desktop-json', 'apps/capture-workbench-desktop/src-tauri/resources/capture-document-v2.schema.json'],
  ] as const) {
    const documentSchema = json(root, sourcePath);
    addExpectedNestedJson(entries, id, 'document-schema', root, sourcePath, documentSchema, ['properties', 'schemaVersion', 'const'], EXPECTED_DOCUMENT_SCHEMA_VERSION);
  }
  addExpectedMatch(entries, 'document.schema.typescript-object', 'document-schema', root, 'packages/capture-runtime-client/src/private/capture-document-schema.ts', /"schemaVersion"\s*:\s*\{\s*"const"\s*:\s*"([^"]+)"/u, EXPECTED_DOCUMENT_SCHEMA_VERSION);

  addExpectedMatch(entries, 'runtime.version.typescript', 'release', root, generatedTsPath, /^export const RUNTIME_VERSION\s*=\s*"([^"]+)"/mu, EXPECTED_RELEASE_VERSION);
  addExpectedMatch(entries, 'runtime.api.typescript', 'api', root, generatedTsPath, /^export const API_VERSION\s*=\s*"([^"]+)"/mu, EXPECTED_RUNTIME_API_VERSION);
  addExpectedMatch(entries, 'document.schema.typescript', 'document-schema', root, generatedTsPath, /^export const CAPTURE_DOCUMENT_SCHEMA_VERSION\s*=\s*"([^"]+)"/mu, EXPECTED_DOCUMENT_SCHEMA_VERSION);
  addExpectedMatch(entries, 'runtime.version.python', 'release', root, generatedPythonPath, /^RUNTIME_VERSION:\s*Final\s*=\s*['"]([^'"]+)['"]/mu, EXPECTED_RELEASE_VERSION);
  addExpectedMatch(entries, 'runtime.api.python', 'api', root, generatedPythonPath, /^API_VERSION:\s*Final\s*=\s*['"]([^'"]+)['"]/mu, EXPECTED_RUNTIME_API_VERSION);
  addExpectedMatch(entries, 'document.schema.python', 'document-schema', root, generatedPythonPath, /^CAPTURE_DOCUMENT_SCHEMA_VERSION:\s*Final\s*=\s*['"]([^'"]+)['"]/mu, EXPECTED_DOCUMENT_SCHEMA_VERSION);
}

function addContractHashEntries(
  entries: InventoryEntry[],
  root: string,
): void {
  const [canonicalBundle] = CONTRACT_BUNDLE_PATHS;
  const digest = createHash('sha256')
    .update(bytes(root, canonicalBundle[1]))
    .digest('hex');
  addInventoryEntry(entries, canonicalBundle[0], 'contract-hash', canonicalBundle[1], digest);
  assertExpected(canonicalBundle[0], digest, EXPECTED_CONTRACT_SET_SHA256, canonicalBundle[1]);
  for (const [id, sourcePath] of CONTRACT_BUNDLE_PATHS.slice(1)) {
    const generatedDigest = createHash('sha256')
      .update(bytes(root, sourcePath))
      .digest('hex');
    addInventoryEntry(entries, id, 'contract-hash', sourcePath, generatedDigest);
    assertExpected(id, generatedDigest, digest, sourcePath);
  }
  for (const [id, sourcePath] of CONTRACT_HASH_PATHS) {
    const declared = strictHash(root, sourcePath, id);
    addInventoryEntry(entries, id, 'contract-hash', sourcePath, declared);
    assertExpected(id, declared, digest, sourcePath);
  }
}

function addChannelIdentityEntries(
  entries: InventoryEntry[],
  root: string,
): void {
  const npmPackages = [
    ['channel.npm.ui.name', 'packages/capture-workbench-ui/package.json', '@gx-capture/capture-workbench-ui'],
    ['channel.npm.runtime-client.name', 'packages/capture-runtime-client/package.json', '@gx-capture/capture-runtime-client'],
  ] as const;
  for (const [id, sourcePath, expected] of npmPackages) {
    addExpectedJson(entries, id, 'channel', root, sourcePath, 'name', expected);
    const packageJson = json(root, sourcePath);
    addExpectedNestedJson(
      entries,
      `${id}.repository`,
      'channel',
      root,
      sourcePath,
      packageJson,
      ['repository', 'url'],
      EXPECTED_GIT_REPOSITORY,
    );
    addExpectedNestedJson(
      entries,
      `${id}.registry`,
      'channel',
      root,
      sourcePath,
      packageJson,
      ['publishConfig', 'registry'],
      EXPECTED_NPM_REGISTRY,
    );
  }
  addExpectedMatch(
    entries,
    'channel.npm.workflow.registry',
    'channel',
    root,
    '.github/workflows/_publish-npm.yml',
    /^\s*registry-url:\s*(\S+)$/mu,
    EXPECTED_NPM_REGISTRY,
  );
  addExpectedMatch(
    entries,
    'channel.npm.workflow.scope',
    'channel',
    root,
    '.github/workflows/_publish-npm.yml',
    /^\s*scope:\s*['"](@gx-capture)['"]$/mu,
    '@gx-capture',
  );

  addExpectedMatch(
    entries,
    'channel.pypi.package.name',
    'channel',
    root,
    'packages/capture-runtime-client-python/pyproject.toml',
    /^\[project\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/mu,
    EXPECTED_PYPI_PROJECT,
  );
  addExpectedMatch(
    entries,
    'channel.pypi.workflow.project',
    'channel',
    root,
    '.github/workflows/_publish-pypi.yml',
    /const project\s*=\s*'([^']+)'/u,
    EXPECTED_PYPI_PROJECT,
  );
  addExpectedMatch(
    entries,
    'channel.pypi.workflow.destination',
    'channel',
    root,
    '.github/workflows/_publish-pypi.yml',
    /fetch\(`([^`]+)`/u,
    EXPECTED_PYPI_WORKFLOW_URL,
  );

  addExpectedMatch(
    entries,
    'channel.maven.package.group',
    'channel',
    root,
    'packages/capture-runtime-client-java/pom.xml',
    /^<project[\s\S]*?^\s*<groupId>([^<]+)<\/groupId>/mu,
    'com.gx.capture',
  );
  addExpectedMatch(
    entries,
    'channel.maven.package.artifact',
    'channel',
    root,
    'packages/capture-runtime-client-java/pom.xml',
    /^<project[\s\S]*?^\s*<artifactId>([^<]+)<\/artifactId>/mu,
    'capture-runtime-client',
  );
  addExpectedMatch(
    entries,
    'channel.maven.package.repository',
    'channel',
    root,
    'packages/capture-runtime-client-java/pom.xml',
    /<distributionManagement>[\s\S]*?<url>(https:\/\/maven\.pkg\.github\.com\/gx-capture\/capture-workbench)<\/url>/u,
    EXPECTED_MAVEN_REPOSITORY,
  );
  addExpectedMatch(
    entries,
    'channel.maven.workflow.repository',
    'channel',
    root,
    '.github/workflows/_publish-maven.yml',
    /repository_url="([^"]+)"/u,
    EXPECTED_MAVEN_WORKFLOW_REPOSITORY,
  );

  addExpectedMatch(
    entries,
    'channel.crates.package.name',
    'channel',
    root,
    'packages/capture-sidecar-launcher/Cargo.toml',
    /^name\s*=\s*"([^"]+)"/mu,
    'capture-sidecar-launcher',
  );
  addExpectedMatch(
    entries,
    'channel.crates.package.repository',
    'channel',
    root,
    'packages/capture-sidecar-launcher/Cargo.toml',
    /^repository\s*=\s*"([^"]+)"/mu,
    EXPECTED_REPOSITORY,
  );
  addExpectedMatch(
    entries,
    'channel.crates.workflow.package',
    'channel',
    root,
    '.github/workflows/_publish-crates.yml',
    /cargo info\s+"([^@"]+)@\$version"/u,
    'capture-sidecar-launcher',
  );
  addExpectedMatch(
    entries,
    'channel.crates.workflow.destination',
    'channel',
    root,
    'tools/publish-crate-candidate.ts',
    /^const CRATES_REGISTRY\s*=\s*'([^']+)'/mu,
    EXPECTED_CRATES_REGISTRY,
  );

  addExpectedMatch(
    entries,
    'channel.github.workflow.repository',
    'channel',
    root,
    'tools/create-github-release.ts',
    /process\.env\.GITHUB_REPOSITORY\s*\?\?\s*'([^']+)'/u,
    'gx-capture/capture-workbench',
  );
  addExpectedMatch(
    entries,
    'channel.github.package.repository',
    'channel',
    root,
    'packages/capture-runtime-client/package.json',
    /"url":\s*"(git\+https:\/\/github\.com\/gx-capture\/capture-workbench\.git)"/u,
    'git+https://github.com/gx-capture/capture-workbench.git',
  );
}

function addChannelEntries(
  entries: InventoryEntry[],
  root: string,
): readonly ChannelOwner[] {
  const owners = CHANNEL_OWNER_SPECS.map((owner) => ({ ...owner }));
  const ownerKeys = owners.map((owner) => `${owner.role}:${owner.workflowPath}`);
  if (new Set(ownerKeys).size !== ownerKeys.length)
    throw new Error('Duplicate channel workflow owner identity.');
  const channels = new Set(owners.flatMap((owner) => owner.channels));
  const expectedChannels = new Set<ReleaseChannel>(RELEASE_CHANNELS);
  if (
    channels.size !== expectedChannels.size ||
    [...expectedChannels].some((channel) => !channels.has(channel))
  ) {
    throw new Error('Release channel inventory is missing or contains an unknown channel.');
  }
  for (const channel of expectedChannels)
    addInventoryEntry(entries, `channel.${channel}`, 'channel', '.agents/SPECS/capture-runtime-042-p2-hardening.md', channel);

  const orchestratorContents = new Map(
    [...new Set(owners.flatMap((owner) => owner.orchestrators))].map((path) => [
      path,
      text(root, path),
    ]),
  );
  const knownWorkflowPaths = new Set<string>(owners.map((owner) => owner.workflowPath));
  for (const [orchestratorPath, content] of orchestratorContents) {
    const references = [...content.matchAll(/uses:\s+(\.\/\.github\/workflows\/_[-A-Za-z0-9]+\.yml)/gu)].map(
      (match) => match[1],
    );
    for (const reference of references) {
      const workflowPath = reference.slice(2);
      if (!knownWorkflowPaths.has(workflowPath))
        throw new Error(`Unknown channel workflow owner ${workflowPath} in ${orchestratorPath}.`);
    }
  }
  for (const owner of owners) {
    const ownerContent = text(root, owner.workflowPath);
    if (matchCount(ownerContent, /^\s*workflow_call:\s*$/mu) !== 1)
      throw new Error(`Missing or duplicate workflow_call in ${owner.workflowPath}.`);
    for (const orchestrator of owner.orchestrators) {
      const content = orchestratorContents.get(orchestrator);
      if (content === undefined) throw new Error(`Missing channel orchestrator ${orchestrator}.`);
      const workflowName = owner.workflowPath
        .slice('.github/workflows/'.length)
        .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const count = matchCount(
        content,
        new RegExp(`uses:\\s+\\./\\.github/workflows/${workflowName}\\b`, 'gu'),
      );
      if (count !== 1)
        throw new Error(`Channel workflow ${owner.workflowPath} must be referenced exactly once in ${orchestrator}; found ${count}.`);
    }
    addInventoryEntry(entries, `channel.owner.${owner.role}.${owner.workflowPath}`, 'channel', owner.workflowPath, `${owner.channels.join(',')}:${owner.role}`);
  }
  addChannelIdentityEntries(entries, root);
  return owners;
}

export function collectReleaseInventory(
  root = workspaceRoot,
): ReleaseInventory {
  const entries: InventoryEntry[] = [];
  const intent = loadReleaseIntent(root);
  assertExpected(
    'release.intent.releaseVersion',
    intent.releaseVersion,
    EXPECTED_RELEASE_VERSION,
    'release/version.json',
  );
  assertExpected(
    'release.intent.runtimeApiVersion',
    intent.runtimeApiVersion,
    EXPECTED_RUNTIME_API_VERSION,
    'release/version.json',
  );
  assertExpected(
    'release.intent.documentSchemaVersion',
    intent.documentSchemaVersion,
    EXPECTED_DOCUMENT_SCHEMA_VERSION,
    'release/version.json',
  );
  const rootPackage = json(root, 'package.json');
  addNestedInventoryEntry(
    entries,
    'workspace.nx',
    'tooling',
    'package.json',
    rootPackage.devDependencies,
    ['nx'],
  );
  assertExpected(
    'workspace.nx',
    entries[entries.length - 1].value,
    EXPECTED_NX_VERSION,
    'package.json',
  );
  const packageManager = stringValue(rootPackage.packageManager);
  if (!packageManager) throw new Error('Missing workspace package manager in package.json.');
  addInventoryEntry(entries, 'workspace.package-manager', 'tooling', 'package.json', packageManager);
  assertExpected('workspace.package-manager', packageManager, 'pnpm@12.0.0', 'package.json');
  const engines = rootPackage.engines;
  addNestedInventoryEntry(entries, 'workspace.node-engine', 'tooling', 'package.json', engines, ['node']);
  addNestedInventoryEntry(entries, 'workspace.pnpm-engine', 'tooling', 'package.json', engines, ['pnpm']);
  assertExpected('workspace.node-engine', entries[entries.length - 2].value, '>=24.0.0', 'package.json');
  assertExpected('workspace.pnpm-engine', entries[entries.length - 1].value, '12.0.0', 'package.json');

  const lockPath = 'pnpm-lock.yaml';
  const lock = text(root, lockPath);
  assertPnpmLockGraphClosed(lock, lockPath);
  addInventoryEntry(entries, 'workspace.pnpm.lock.graph', 'tooling', lockPath, 'closed');
  const specifiers = [...lock.matchAll(/^\s*['"]?(?:@nx\/[^'"]+|nx)['"]?:\s*\n?\n\s+specifier:\s+([0-9]+\.[0-9]+\.[0-9]+)/gmu)].map((match) => match[1]);
  if (specifiers.length === 0) throw new Error(`Missing Nx specifiers in ${lockPath}.`);
  specifiers.forEach((value, index) => {
    addInventoryEntry(entries, `workspace.nx.lock.specifier.${index + 1}`, 'tooling', lockPath, value);
    assertExpected(`workspace.nx.lock.specifier.${index + 1}`, value, EXPECTED_NX_VERSION, lockPath);
  });
  const resolved = [...lock.matchAll(/(?:['"]?@nx\/[A-Za-z0-9_-]+|['"]?nx)@([0-9]+\.[0-9]+\.[0-9]+)/gu)].map((match) => match[1]);
  if (resolved.length === 0) throw new Error(`Missing Nx resolutions in ${lockPath}.`);
  resolved.forEach((value, index) => {
    addInventoryEntry(entries, `workspace.nx.lock.resolution.${index + 1}`, 'tooling', lockPath, value);
    assertExpected(`workspace.nx.lock.resolution.${index + 1}`, value, EXPECTED_NX_VERSION, lockPath);
  });

  addReleaseSourceEntries(entries, root);
  addProjectionEntries(entries, root);
  addContractHashEntries(entries, root);
  const channelOwners = addChannelEntries(entries, root);
  return { entries, channelOwners };
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
