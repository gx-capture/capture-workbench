import '../test-temp-root.ts';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectReleaseInventory, workspaceRoot } from './version-sources.ts';

const LOCK = `lockfileVersion: '9.0'

importers:
  .:
    devDependencies:
      nx:
        specifier: 23.1.2
        version: 23.1.2
  'packages/empty': {}
  "packages/example":
    dependencies:
      '@scope/pkg':
        specifier: 1.2.3
        version: '1.2.3(peer@4.5.6)'

packages:
  nx@23.1.2: {}
  '@scope/pkg@1.2.3': {}
  "peer@4.5.6": {}

snapshots:
  nx@23.1.2: {}
  '@scope/pkg@1.2.3(peer@4.5.6)':
    dependencies:
      "peer": '4.5.6'
    optionalDependencies:
      '@scope/pkg': "1.2.3(peer@4.5.6)"
  "peer@4.5.6": {}
`;

async function withLockFixture(
  lock: string,
  callback: (root: string) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'capture-pnpm-lock-'));
  try {
    // The inventory reads other release sources; only the lock is under test.
    for (const directory of [
      'apps',
      'packages',
      'release',
      '.github',
      'tools',
    ]) {
      await symlink(
        join(workspaceRoot, directory),
        join(root, directory),
        'junction',
      );
    }
    await copyFile(
      join(workspaceRoot, 'package.json'),
      join(root, 'package.json'),
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), lock, 'utf8');
    callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertClosed(root: string): void {
  const inventory = collectReleaseInventory(root);
  assert.deepEqual(
    inventory.entries.find((entry) => entry.id === 'workspace.pnpm.lock.graph'),
    {
      id: 'workspace.pnpm.lock.graph',
      kind: 'tooling',
      sourcePath: 'pnpm-lock.yaml',
      value: 'closed',
    },
  );
}

test('pnpm lock accepts single and double quoted importer, package and dependency keys', async () => {
  await withLockFixture(LOCK.replaceAll('(peer@4.5.6)', ''), assertClosed);
});

test('pnpm lock resolves peer-suffixed importer and snapshot references to a base package', async () => {
  await withLockFixture(LOCK, assertClosed);
});

test('pnpm lock accepts an importer with no dependency entries', async () => {
  const lock = LOCK.replace(
    "  \"packages/example\":\n    dependencies:\n      '@scope/pkg':\n        specifier: 1.2.3\n        version: '1.2.3(peer@4.5.6)'",
    '  "packages/example":\n    dependencies: {}',
  );
  assert.notEqual(lock, LOCK);
  await withLockFixture(lock, assertClosed);
});

test('pnpm lock reports the exact missing importer reference including its peer suffix', async () => {
  const lock = LOCK.replace(
    "version: '1.2.3(peer@4.5.6)'",
    "version: '9.9.9(peer@4.5.6)'",
  );
  await withLockFixture(lock, (root) => {
    assert.throws(() => collectReleaseInventory(root), {
      message:
        'Missing pnpm package/snapshot for @scope/pkg@9.9.9(peer@4.5.6) referenced by importer in pnpm-lock.yaml.',
    });
  });
});

test('pnpm lock reports the exact missing snapshot dependency with its owner', async () => {
  const lock = LOCK.replace('"peer": \'4.5.6\'', '"peer": \'9.9.9\'');
  await withLockFixture(lock, (root) => {
    assert.throws(() => collectReleaseInventory(root), {
      message:
        'Missing pnpm package/snapshot for peer@9.9.9 referenced by @scope/pkg@1.2.3(peer@4.5.6) in pnpm-lock.yaml.',
    });
  });
});

test('pnpm lock rejects a snapshot reference whose base package is absent', async () => {
  const lock = LOCK.replace("  '@scope/pkg@1.2.3': {}\n", '');
  await withLockFixture(lock, (root) => {
    assert.throws(() => collectReleaseInventory(root), {
      message:
        'Missing pnpm package/snapshot for @scope/pkg@1.2.3(peer@4.5.6) referenced by @scope/pkg@1.2.3(peer@4.5.6) in pnpm-lock.yaml.',
    });
  });
});

test('pnpm lock requires the exact peer snapshot even when its base version exists', async () => {
  const lock = LOCK.replace(
    "version: '1.2.3(peer@4.5.6)'",
    "version: '1.2.3(peer@9.9.9)'",
  );
  await withLockFixture(lock, (root) => {
    assert.throws(() => collectReleaseInventory(root), {
      message:
        'Missing pnpm package/snapshot for @scope/pkg@1.2.3(peer@9.9.9) referenced by importer in pnpm-lock.yaml.',
    });
  });
});

test('pnpm lock reports the exact missing snapshot for a package', async () => {
  const lock = LOCK.replace(
    '  "peer@4.5.6": {}\n\n',
    '  "peer@4.5.6": {}\n  orphan@7.8.9: {}\n\n',
  );
  await withLockFixture(lock, (root) => {
    assert.throws(() => collectReleaseInventory(root), {
      message:
        'Missing pnpm snapshot for package orphan@7.8.9 in pnpm-lock.yaml.',
    });
  });
});
