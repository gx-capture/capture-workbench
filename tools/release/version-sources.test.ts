import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  collectReleaseInventory,
  collectReleaseVersionEntries,
  loadReleaseIntent,
  replaceReleaseVersion,
  verifyGeneratedVersions,
  workspaceRoot,
} from './version-sources.ts';

const INVENTORY_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'release/version.json',
  'packages/capture-workbench-ui/package.json',
  'packages/capture-runtime-client/package.json',
  'packages/capture-runtime-client-python/pyproject.toml',
  'packages/capture-runtime/pyproject.toml',
  'packages/capture-sidecar-launcher/Cargo.toml',
  'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.toml',
  'apps/capture-workbench-desktop/src-tauri/Cargo.toml',
  'apps/capture-workbench-desktop/src-tauri/tauri.conf.json',
  'packages/capture-runtime-client-java/pom.xml',
  'packages/capture-runtime/src/capture_runtime/constants/versions.py',
  'packages/capture-runtime/scripts/model_source_lock.py',
  'packages/capture-runtime/scripts/generate_commit_a_fixtures.py',
  'packages/capture-runtime/project.json',
  'packages/capture-runtime/model-sources/release-model-source-lock.json',
  'packages/capture-runtime/src/capture_runtime/assets/engine-catalog.json',
  'packages/capture-runtime/src/capture_runtime/assets/ocr-profile.json',
  'apps/capture-workbench-desktop/src-tauri/resources/capture-document-v2.schema.json',
  'apps/capture-workbench-desktop/src-tauri/resources/capture-runtime-manifest.example.json',
  'apps/capture-workbench-desktop/scripts/stage-deterministic-runtime.ts',
  'apps/capture-workbench-desktop/scripts/stage-runtime.ts',
  'apps/capture-workbench-desktop/scripts/real-media-model-smoke.ts',
  'packages/capture-runtime/src/capture_runtime/contracts/__init__.py',
  'packages/capture-sidecar-launcher/src/health.rs',
  'packages/capture-sidecar-launcher/src/manifest.rs',
  'packages/capture-sidecar-launcher/src/lib.rs',
  'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/src/contract.rs',
  'apps/capture-workbench-desktop/src-tauri/src/config.rs',
  'apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs',
  'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
  'packages/capture-runtime-client/src/private/assets/contract-set.json',
  'packages/capture-runtime-client-python/src/capture_runtime_client/private/assets/contract-set.json',
  'packages/capture-runtime-client/src/private/generated-contracts.ts',
  'packages/capture-runtime-client/src/private/capture-document-schema.ts',
  'packages/capture-runtime-client-python/src/capture_runtime_client/private/generated_models.py',
  'packages/capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-document.schema.json',
  'packages/capture-runtime-client-python/src/capture_runtime_client/private/schemas/raw-capture.schema.json',
  'packages/capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-ocr-projection-v3.schema.json',
  'packages/capture-runtime-client-java/src/main/java/com/gx/capture/runtime/client/CaptureRuntimeTypes.java',
  'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
  'packages/capture-runtime-client/src/private/assets/contract-set.sha256',
  'packages/capture-runtime-client-python/src/capture_runtime_client/private/assets/contract-set.sha256',
  'packages/capture-runtime-client-java/src/main/resources/capture-runtime-contract-set.sha256',
  '.github/workflows/release-promote.yml',
  '.github/workflows/runtime-promote.yml',
  '.github/workflows/_publish-npm.yml',
  '.github/workflows/_publish-pypi.yml',
  '.github/workflows/_publish-maven.yml',
  '.github/workflows/_publish-crates.yml',
  '.github/workflows/_publish-github-release.yml',
  '.github/workflows/_publish-runtime-github-release.yml',
  '.github/workflows/_verify-registries.yml',
  '.github/workflows/_publish-promotion-ledger.yml',
  '.github/workflows/_publish-stable-pointer.yml',
  'tools/publish-crate-candidate.ts',
  'tools/record-pypi-candidate.ts',
  'tools/create-github-release.ts',
];

async function withFixture<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const temporaryParent = await mkdtemp(
    join(tmpdir(), 'capture-release-inventory-'),
  );
  const fixtureRoot = join(temporaryParent, 'workspace');
  for (const relativePath of INVENTORY_FILES) {
    const destination = join(fixtureRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(workspaceRoot, relativePath), destination);
  }
  for (const relativePath of ['package.json', 'pnpm-lock.yaml']) {
    const path = join(fixtureRoot, relativePath);
    const contents = await readFile(path, 'utf8');
    await writeFile(path, contents.replace(/\b23\.1\.0\b/gu, '23.1.2'), 'utf8');
  }
  try {
    return await callback(fixtureRoot);
  } finally {
    await rm(temporaryParent, { recursive: true, force: true });
  }
}

function requiredEntry(
  inventory: ReturnType<typeof collectReleaseInventory>,
  id: string,
  value: string,
): void {
  const matches = inventory.entries.filter((entry) => entry.id === id);
  assert.equal(matches.length, 1, `expected exactly one ${id} entry`);
  assert.equal(matches[0].value, value);
}

test('release intent is the synchronized source for all release-managed versions', () => {
  const intent = verifyGeneratedVersions(workspaceRoot);
  const entries = collectReleaseVersionEntries(workspaceRoot);
  assert.ok(entries.length >= 30);
  assert.ok(entries.every((entry) => entry.value === intent.releaseVersion));
  assert.ok(entries.some((entry) => entry.label === 'Java runtime client POM'));
  assert.deepEqual(loadReleaseIntent(workspaceRoot), {
    releaseVersion: '0.4.2',
    runtimeApiVersion: '2.0',
    documentSchemaVersion: '2',
  });
});

test('typed release inventory reports every D2.1 identity without mutation', () => {
  const inventory = collectReleaseInventory(workspaceRoot);
  const ids = inventory.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  requiredEntry(inventory, 'workspace.nx', '23.1.2');
  requiredEntry(inventory, 'release.version', '0.4.2');
  requiredEntry(inventory, 'runtime.api', '2.0');
  requiredEntry(inventory, 'document.schema', '2');
  requiredEntry(inventory, 'ocr.projection.schema', '3');
  for (const id of [
    'contract.bundle.sha256',
    'contract.asset.runtime.sha256',
    'contract.asset.typescript.sha256',
    'contract.asset.python.sha256',
    'contract.asset.java.sha256',
  ]) {
    requiredEntry(
      inventory,
      id,
      'd293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40',
    );
  }
  for (const channel of [
    'npm-github-packages',
    'pypi',
    'maven-github-packages',
    'crates-io',
    'github-releases',
  ] as const) {
    assert.ok(
      inventory.channelOwners.some((owner) => owner.channels.includes(channel)),
      `missing logical channel ${channel}`,
    );
  }
  assert.equal(inventory.channelOwners.length, 9);
});

const R3_HEALTH_PATH = 'packages/capture-sidecar-launcher/src/health.rs';
const R3_IDENTITIES = [
  ['R3_SERVICE', 'runtime.service.sidecar-health', 'capture-runtime', 'other-runtime'],
  ['R3_RUNTIME_VERSION', 'runtime.version.sidecar-health', '0.4.2', '0.4.3'],
  ['R3_API_VERSION', 'runtime.api.sidecar-health', '2.0', '2.1'],
  ['R3_DOCUMENT_SCHEMA_VERSION', 'document.schema.sidecar-health', '2', '3'],
  ['R3_CONTRACT_SET_VERSION', 'contract-set.version.sidecar-health', '2', '3'],
] as const;

test('R3 inventory uses production identities and preserves negative test fixtures', async () => {
  await withFixture(async (root) => {
    const path = join(root, R3_HEALTH_PATH);
    const before = await readFile(path, 'utf8');
    assert.match(before, /foreign_manifest\.runtime_version = "0\.4\.3"/u);
    assert.match(before, /\("runtimeVersion", serde_json::json!\("0\.4\.1"\)\)/u);
    const inventory = collectReleaseInventory(root);
    for (const [, id, value] of R3_IDENTITIES) requiredEntry(inventory, id, value);
    const versions = collectReleaseVersionEntries(root);
    assert.ok(versions.every((entry) => entry.value === '0.4.2'));
    assert.equal(verifyGeneratedVersions(root).releaseVersion, '0.4.2');
    assert.equal(await readFile(path, 'utf8'), before);
  });
});

for (const [name, id, value, wrong] of R3_IDENTITIES) {
  for (const mutation of ['drift', 'missing', 'duplicate'] as const) {
    test(`R3 inventory rejects ${mutation} of production ${name}`, async () => {
      await withFixture(async (root) => {
        const path = join(root, R3_HEALTH_PATH);
        const before = await readFile(path, 'utf8');
        const declaration = `const ${name}: &str = "${value}";`;
        const replacement = mutation === 'drift'
          ? `const ${name}: &str = "${wrong}";`
          : mutation === 'missing' ? '' : `${declaration}\n  ${declaration}`;
        const changed = before.replace(declaration, replacement);
        assert.notEqual(changed, before);
        await writeFile(path, changed, 'utf8');
        assert.throws(() => collectReleaseInventory(root), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(id), error.message);
          return true;
        });
        if (name === 'R3_RUNTIME_VERSION') {
          assert.throws(() => verifyGeneratedVersions(root), /sidecar|R3|release/iu);
        }
        assert.equal(await readFile(path, 'utf8'), changed);
      });
    });
  }
}

test('inventory rejects stale Nx identity before changing fixture bytes', async () => {
  await withFixture(async (root) => {
    const path = join(root, 'package.json');
    const before = await readFile(path, 'utf8');
    const stale = before.replace('"nx": "23.1.2"', '"nx": "23.1.0"');
    assert.notEqual(stale, before);
    await writeFile(path, stale, 'utf8');
    assert.throws(
      () => collectReleaseInventory(root),
      /Nx|23\.1\.2|workspace\.nx/u,
    );
    assert.equal(await readFile(path, 'utf8'), stale);
  });
});

test('inventory rejects mixed API and document schema identities', async () => {
  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime/src/capture_runtime/constants/versions.py',
    );
    const before = await readFile(path, 'utf8');
    const mixed = before.replace(
      'API_VERSION: Final = "2.0"',
      'API_VERSION: Final = "2.1"',
    );
    assert.notEqual(mixed, before);
    await writeFile(path, mixed, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /api|2\.0/u);
    assert.equal(await readFile(path, 'utf8'), mixed);
  });

  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime/src/capture_runtime/constants/versions.py',
    );
    const before = await readFile(path, 'utf8');
    const mixed = before.replace(
      'CAPTURE_DOCUMENT_SCHEMA_VERSION: Final = "2"',
      'CAPTURE_DOCUMENT_SCHEMA_VERSION: Final = "3"',
    );
    assert.notEqual(mixed, before);
    await writeFile(path, mixed, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /document|schema|2/u);
    assert.equal(await readFile(path, 'utf8'), mixed);
  });
});

test('inventory rejects mixed projection identity and duplicate generated source', async () => {
  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime-client/src/private/generated-contracts.ts',
    );
    const before = await readFile(path, 'utf8');
    const mixed = before.replace(
      'readonly schemaVersion: "3";',
      'readonly schemaVersion: "4";',
    );
    assert.notEqual(mixed, before);
    await writeFile(path, mixed, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /projection|schema/u);
    assert.equal(await readFile(path, 'utf8'), mixed);
  });

  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime-client/src/private/generated-contracts.ts',
    );
    const before = await readFile(path, 'utf8');
    const duplicate = before.replace(
      'export interface CaptureOcrProjectionV3 {',
      'export interface CaptureOcrProjectionV3 {\nexport interface CaptureOcrProjectionV3 {',
    );
    assert.notEqual(duplicate, before);
    await writeFile(path, duplicate, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /duplicate|projection/u);
    assert.equal(await readFile(path, 'utf8'), duplicate);
  });
});

test('inventory rejects missing source and duplicate hash identities', async () => {
  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime/src/capture_runtime/constants/versions.py',
    );
    const before = await readFile(path, 'utf8');
    const missing = before.replace(
      /RUNTIME_VERSION: Final = "0\.4\.2"\r?\n/u,
      '',
    );
    assert.notEqual(missing, before);
    await writeFile(path, missing, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /runtime|version|missing/u);
    assert.equal(await readFile(path, 'utf8'), missing);
  });

  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
    );
    const before = await readFile(path, 'utf8');
    const duplicate = `${before}${before}`;
    await writeFile(path, duplicate, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /hash|digest|contract/u);
    assert.equal(await readFile(path, 'utf8'), duplicate);
  });
});

test('inventory rejects an all-equal but incorrect contract hash', async () => {
  await withFixture(async (root) => {
    const paths = [
      'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
      'packages/capture-runtime-client/src/private/assets/contract-set.sha256',
      'packages/capture-runtime-client-python/src/capture_runtime_client/private/assets/contract-set.sha256',
      'packages/capture-runtime-client-java/src/main/resources/capture-runtime-contract-set.sha256',
    ];
    const wrong = `${'0'.repeat(64)}\n`;
    const before = await Promise.all(
      paths.map(async (path) => [path, await readFile(join(root, path), 'utf8')] as const),
    );
    for (const path of paths) await writeFile(join(root, path), wrong, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /hash|digest|contract/u);
    for (const [path] of before)
      assert.equal(await readFile(join(root, path), 'utf8'), wrong);
  });
});

test('inventory rejects generated contract bundle drift', async () => {
  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime-client/src/private/assets/contract-set.json',
    );
    const before = await readFile(path, 'utf8');
    const drifted = `${before}\n`;
    await writeFile(path, drifted, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /contract|hash|digest/u);
    assert.equal(await readFile(path, 'utf8'), drifted);
  });
});

test('inventory rejects missing hash and duplicate channel owner references', async () => {
  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime-client-python/src/capture_runtime_client/private/assets/contract-set.sha256',
    );
    await rm(path);
    assert.throws(() => collectReleaseInventory(root), /missing|hash|contract/u);
    assert.equal(await readFile(path).catch(() => undefined), undefined);
  });

  await withFixture(async (root) => {
    const path = join(root, '.github/workflows/release-promote.yml');
    const before = await readFile(path, 'utf8');
    const marker = 'uses: ./.github/workflows/_publish-npm.yml';
    const duplicate = before.replace(marker, `${marker}\n    ${marker}`);
    assert.notEqual(duplicate, before);
    await writeFile(path, duplicate, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /duplicate|channel|workflow/u);
    assert.equal(await readFile(path, 'utf8'), duplicate);
  });

  await withFixture(async (root) => {
    const path = join(root, '.github/workflows/release-promote.yml');
    const before = await readFile(path, 'utf8');
    const marker = 'uses: ./.github/workflows/_publish-npm.yml';
    const malformedDuplicate = before.replace(
      marker,
      `${marker}\n    uses: ./.github/workflows/_publish-npm-wrong.yml`,
    );
    assert.notEqual(malformedDuplicate, before);
    await writeFile(path, malformedDuplicate, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /Unknown channel workflow|workflow/u);
    assert.equal(await readFile(path, 'utf8'), malformedDuplicate);
  });
});

test('inventory rejects a self-consistent release and API drift against Phase2 defaults', async () => {
  await withFixture(async (root) => {
    const paths = [
      'release/version.json',
      'packages/capture-runtime/src/capture_runtime/constants/versions.py',
      'packages/capture-workbench-ui/package.json',
      'packages/capture-runtime-client/package.json',
      'packages/capture-runtime-client-python/pyproject.toml',
      'packages/capture-runtime/pyproject.toml',
      'packages/capture-sidecar-launcher/Cargo.toml',
      'apps/capture-workbench-desktop/src-tauri/Cargo.toml',
      'apps/capture-workbench-desktop/src-tauri/tauri.conf.json',
      'packages/capture-runtime-client-java/pom.xml',
    ];
    for (const relativePath of paths) {
      const path = join(root, relativePath);
      const before = await readFile(path, 'utf8');
      const drifted = before
        .replaceAll('0.4.2', '0.4.3')
        .replaceAll('2.0', '2.1')
        .replace('"documentSchemaVersion": "2"', '"documentSchemaVersion": "3"');
      assert.notEqual(drifted, before, relativePath);
      await writeFile(path, drifted, 'utf8');
    }
    assert.throws(() => collectReleaseInventory(root), /Phase2|expected 0\.4\.2|release\.intent/u);
  });
});

test('inventory rejects a missing Nx package field before mutation', async () => {
  await withFixture(async (root) => {
    const path = join(root, 'package.json');
    const before = await readFile(path, 'utf8');
    const packageJson = JSON.parse(before) as { devDependencies: Record<string, unknown> };
    delete packageJson.devDependencies.nx;
    const missing = `${JSON.stringify(packageJson, null, 2)}\n`;
    await writeFile(path, missing, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /workspace\.nx|missing|identity/u);
    assert.equal(await readFile(path, 'utf8'), missing);
  });
});

test('inventory rejects duplicate nested JSON owners before mutation', async () => {
  await withFixture(async (root) => {
    const path = join(root, 'packages/capture-runtime-client/package.json');
    const before = await readFile(path, 'utf8');
    const duplicate = before.replace(
      '"registry": "https://npm.pkg.github.com",\n    "access": "public"',
      '"registry": "https://npm.pkg.github.com",\n    "registry": "https://example.invalid",\n    "access": "public"',
    );
    assert.notEqual(duplicate, before);
    await writeFile(path, duplicate, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /duplicate JSON key|registry/u);
    assert.equal(await readFile(path, 'utf8'), duplicate);
  });
});

test('inventory rejects a channel destination drift before mutation', async () => {
  await withFixture(async (root) => {
    const path = join(root, '.github/workflows/_publish-npm.yml');
    const before = await readFile(path, 'utf8');
    const drifted = before.replace(
      'registry-url: https://npm.pkg.github.com',
      'registry-url: https://example.invalid',
    );
    assert.notEqual(drifted, before);
    await writeFile(path, drifted, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /channel\.npm\.workflow\.registry|npm\.pkg|destination/u);
    assert.equal(await readFile(path, 'utf8'), drifted);
  });
});

test('inventory rejects every channel destination and package identity mutation', async () => {
  const cases = [
    {
      name: 'npm destination suffix',
      sourcePath: '.github/workflows/_publish-npm.yml',
      find: 'registry-url: https://npm.pkg.github.com',
      replace: 'registry-url: https://npm.pkg.github.com/other',
      expected: /channel\.npm|registry/u,
    },
    {
      name: 'npm package name',
      sourcePath: 'packages/capture-workbench-ui/package.json',
      find: '"name": "@gx-capture/capture-workbench-ui"',
      replace: '"name": "@gx-capture/capture-workbench-ui-wrong"',
      expected: /channel\.npm|name/u,
    },
    {
      name: 'PyPI destination suffix',
      sourcePath: 'tools/record-pypi-candidate.ts',
      find: 'https://pypi.org/pypi/${project}/${version}/json',
      replace: 'https://pypi.org/pypi/${project}/${version}/json/other',
      expected: /channel\.pypi|PyPI/u,
    },
    {
      name: 'PyPI project name',
      sourcePath: 'tools/record-pypi-candidate.ts',
      find: "const PROJECTS = ['capture-runtime-client'] as const",
      replace: "const PROJECTS = ['capture-runtime-client-wrong'] as const",
      expected: /channel\.pypi|project/u,
    },
    {
      name: 'Maven destination suffix',
      sourcePath: '.github/workflows/_publish-maven.yml',
      find: 'repository_url="https://maven.pkg.github.com/gx-capture/capture-workbench/com/gx/capture/capture-runtime-client/${{ inputs.release_version }}"',
      replace: 'repository_url="https://maven.pkg.github.com/gx-capture/capture-workbench/com/gx/capture/capture-runtime-client/${{ inputs.release_version }}/other"',
      expected: /channel\.maven|Maven/u,
    },
    {
      name: 'Maven artifact name',
      sourcePath: 'packages/capture-runtime-client-java/pom.xml',
      find: '<artifactId>capture-runtime-client</artifactId>',
      replace: '<artifactId>capture-runtime-client-wrong</artifactId>',
      expected: /channel\.maven|artifact/u,
    },
    {
      name: 'crates.io destination suffix',
      sourcePath: 'tools/publish-crate-candidate.ts',
      find: "const CRATES_REGISTRY = 'https://crates.io/api/v1/crates'",
      replace: "const CRATES_REGISTRY = 'https://crates.io/api/v1/crates/other'",
      expected: /channel\.crates|crates/u,
    },
    {
      name: 'crate package name',
      sourcePath: 'packages/capture-sidecar-launcher/Cargo.toml',
      find: 'name = "capture-sidecar-launcher"',
      replace: 'name = "capture-sidecar-launcher-wrong"',
      expected: /channel\.crates|package/u,
    },
    {
      name: 'GitHub destination repository suffix',
      sourcePath: 'tools/create-github-release.ts',
      find: "process.env.GITHUB_REPOSITORY ?? 'gx-capture/capture-workbench'",
      replace: "process.env.GITHUB_REPOSITORY ?? 'gx-capture/capture-workbench-wrong'",
      expected: /channel\.github|repository/u,
    },
    {
      name: 'GitHub package repository',
      sourcePath: 'packages/capture-runtime-client/package.json',
      find: 'git+https://github.com/gx-capture/capture-workbench.git',
      replace: 'git+https://github.com/gx-capture/capture-workbench-wrong.git',
      expected: /channel\.github|repository/u,
    },
  ] as const;
  for (const testCase of cases) {
    await withFixture(async (root) => {
      const path = join(root, testCase.sourcePath);
      const before = await readFile(path, 'utf8');
      const drifted = before.replace(testCase.find, testCase.replace);
      assert.notEqual(drifted, before, testCase.name);
      await writeFile(path, drifted, 'utf8');
      assert.throws(() => collectReleaseInventory(root), testCase.expected);
      assert.equal(await readFile(path, 'utf8'), drifted);
    });
  }
});

test('inventory rejects a stale pnpm package and snapshot reference before mutation', async () => {
  await withFixture(async (root) => {
    const path = join(root, 'pnpm-lock.yaml');
    const before = await readFile(path, 'utf8');
    const stale = before.replace('axios: 1.18.1', 'axios: 9.99.99');
    assert.notEqual(stale, before);
    await writeFile(path, stale, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /pnpm package\/snapshot|axios|graph/u);
    assert.equal(await readFile(path, 'utf8'), stale);
  });
  await withFixture(async (root) => {
    const path = join(root, 'pnpm-lock.yaml');
    const before = await readFile(path, 'utf8');
    const stale = before.replace('open: 10.1.0', 'open: 99.99.99');
    assert.notEqual(stale, before);
    await writeFile(path, stale, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /pnpm package\/snapshot|open|graph/u);
    assert.equal(await readFile(path, 'utf8'), stale);
  });
});

test('inventory rejects generated projection structural identity drift before mutation', async () => {
  await withFixture(async (root) => {
    const path = join(
      root,
      'packages/capture-runtime-client/src/private/generated-contracts.ts',
    );
    const before = await readFile(path, 'utf8');
    const drifted = before.replace(
      'export interface CaptureOcrProjectionV3 {',
      'export interface CaptureOcrProjectionV4 {',
    );
    assert.notEqual(drifted, before);
    await writeFile(path, drifted, 'utf8');
    assert.throws(() => collectReleaseInventory(root), /projection|generated|identity/u);
    assert.equal(await readFile(path, 'utf8'), drifted);
  });
});

test('release replacement is exact and does not alter adjacent versions', () => {
  assert.equal(
    replaceReleaseVersion('0.4.2 0.3.100 v0.4.2', '0.4.2', '0.4.2'),
    '0.4.2 0.3.100 v0.4.2',
  );
});
