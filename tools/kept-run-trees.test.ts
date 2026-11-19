import './test-temp-root.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  KEPT_RUN_TREE_MARKER,
  KEPT_RUN_TREES_ROOT_VARIABLE,
  createKeptRunTree,
  keepsRunTrees,
  listKeptRunTrees,
  removeKeptRunTree,
  runKeptRunTreesCli,
} from './kept-run-trees.ts';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'kept-run-trees.ts');

function environmentWithRoot() {
  const parent = mkdtempSync(join(tmpdir(), 'kept-run-trees-'));
  const root = join(parent, 'kept');
  return { parent, root, environment: { [KEPT_RUN_TREES_ROOT_VARIABLE]: root } as NodeJS.ProcessEnv };
}

test('keeps run trees everywhere except on GitHub runners, whatever CI says', () => {
  assert.equal(keepsRunTrees({}), true);
  assert.equal(keepsRunTrees({ CI: 'true' }), true);
  assert.equal(keepsRunTrees({ GITHUB_ACTIONS: 'false' }), true);
  assert.equal(keepsRunTrees({ GITHUB_ACTIONS: 'true' }), false);
  assert.equal(keepsRunTrees({ GITHUB_ACTIONS: 'true', CI: 'true' }), false);
});

test('creates a fresh marked run directory under the configured root', () => {
  const { root, environment } = environmentWithRoot();
  const now = new Date(2025, 0, 2, 3, 4, 5);
  const path = createKeptRunTree({ script: 'synthetic-smoke', directoryPrefix: 'synthetic', environment, now });
  assert.equal(dirname(path), root);
  assert.equal(basename(path), 'synthetic-20250102030405');
  assert.deepEqual(JSON.parse(readFileSync(join(path, KEPT_RUN_TREE_MARKER), 'utf8')), {
    script: 'synthetic-smoke',
    createdAt: now.toISOString(),
    reason: 'Kept by a local run; safe to delete when no run uses it.',
    remove: `pnpm run kept-run-trees -- --remove ${path}`,
  });

  const second = createKeptRunTree({ script: 'synthetic-smoke', directoryPrefix: 'synthetic', environment, now });
  assert.notEqual(second, path);
  assert.equal(dirname(second), root);
  assert.deepEqual(
    listKeptRunTrees(environment).map((tree) => tree.path).sort(),
    [path, second].sort(),
  );
});

test('rejects a relative root and an unsafe directory prefix', () => {
  assert.throws(
    () => createKeptRunTree({ script: 's', directoryPrefix: 'p', environment: { [KEPT_RUN_TREES_ROOT_VARIABLE]: 'relative/root' } }),
    /absolute path/u,
  );
  const { environment } = environmentWithRoot();
  assert.throws(() => createKeptRunTree({ script: 's', directoryPrefix: '../escape', environment }), /prefix/u);
});

test('removes one marked tree under the root and refuses everything else', () => {
  const { parent, root, environment } = environmentWithRoot();
  const kept = createKeptRunTree({ script: 'synthetic-smoke', directoryPrefix: 'synthetic', environment });
  writeFileSync(join(kept, 'payload.txt'), 'payload');
  const unmarked = join(root, 'unmarked');
  mkdirSync(unmarked);
  const outside = join(parent, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, KEPT_RUN_TREE_MARKER), JSON.stringify({ script: 's', createdAt: 'c' }));
  const nested = join(kept, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, KEPT_RUN_TREE_MARKER), JSON.stringify({ script: 's', createdAt: 'c' }));

  assert.throws(() => removeKeptRunTree(unmarked, environment), /no kept-run-tree\.json marker/u);
  assert.throws(() => removeKeptRunTree(outside, environment), /not a kept run tree/u);
  assert.throws(() => removeKeptRunTree(nested, environment), /not a kept run tree/u);
  assert.throws(() => removeKeptRunTree(root, environment), /not a kept run tree/u);
  assert.equal(existsSync(unmarked) && existsSync(outside) && existsSync(nested), true);

  assert.equal(removeKeptRunTree(kept, environment), kept);
  assert.equal(existsSync(kept), false);
  assert.equal(existsSync(root), true);
});

test('refuses paths that only look like a kept tree under the root', () => {
  const { parent, root, environment } = environmentWithRoot();
  const kept = createKeptRunTree({ script: 'synthetic-smoke', directoryPrefix: 'synthetic', environment });
  const sibling = join(parent, 'sibling');
  mkdirSync(sibling);
  writeFileSync(join(sibling, KEPT_RUN_TREE_MARKER), JSON.stringify({ script: 's', createdAt: 'c' }));
  const junction = join(root, 'junction');
  symlinkSync(sibling, junction, 'junction');
  const fakeMarker = join(root, 'fake-marker');
  mkdirSync(join(fakeMarker, KEPT_RUN_TREE_MARKER), { recursive: true });

  for (const path of [
    join(root, '..', 'sibling'),
    junction,
    fakeMarker,
    root.toUpperCase(),
    join(root.toUpperCase(), '..', 'sibling'),
    join(parent.toUpperCase(), 'sibling'),
    join(kept, '..'),
  ]) {
    assert.throws(() => removeKeptRunTree(path, environment), /Refusing to remove/u, path);
  }
  for (const path of [kept, sibling, join(sibling, KEPT_RUN_TREE_MARKER), junction, fakeMarker, root]) {
    assert.equal(existsSync(path), true, path);
  }
});

test('the command line lists kept trees and removes exactly one', () => {
  const { root, environment } = environmentWithRoot();
  const kept = createKeptRunTree({ script: 'synthetic-smoke', directoryPrefix: 'synthetic', environment });
  const childEnvironment = { ...process.env, ...environment };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cliPath, ...args], { env: childEnvironment, encoding: 'utf8' });

  const listed = run('--', '--list');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`synthetic-smoke`, 'u'));
  assert.ok(listed.stdout.includes(kept));

  const refused = run('--remove', root);
  assert.equal(refused.status, 1);
  assert.equal(existsSync(root), true);

  assert.equal(run('--remove').status, 2);
  assert.equal(run('--remove', kept, kept).status, 2);

  const removed = run('--', '--remove', kept);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(kept), false);
});

test('the command line creates a marked tree and prints only its path', () => {
  const { root, environment } = environmentWithRoot();
  const created = spawnSync(process.execPath, [cliPath, '--create', 'synthetic-smoke', 'synthetic'], {
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);
  const path = created.stdout.trim();
  assert.equal(dirname(path), root);
  assert.equal(JSON.parse(readFileSync(join(path, KEPT_RUN_TREE_MARKER), 'utf8')).script, 'synthetic-smoke');
});

test('the command line reports an empty root', () => {
  const { environment } = environmentWithRoot();
  const output: string[] = [];
  const code = runKeptRunTreesCli(['--list'], { stdout: (text) => output.push(text), stderr: (text) => output.push(text) }, environment);
  assert.equal(code, 0);
  assert.match(output.join(''), /No kept run trees/u);
});
