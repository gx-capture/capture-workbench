// The test-scripts target preloads tools/test-temp-root.ts with `node --import`
// (an import here would cross the Nx project boundary); these tests also remove
// their own directories, so a direct `node --test` run leaves nothing behind.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import {
  createdParents,
  desktopCdpArguments,
  ownedProcessCleanupFailure,
  prepareRunDataRoot,
  removeRunDataRoot,
  runDataEnvironment,
  runDataRootMaxCharacters,
} from './packaged-workbench-session.ts';

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryRoots.map((directory) => rm(directory, { recursive: true, force: true })));
});

const variable = 'CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT';

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

test('the run data root must be named and short enough for engine workers to load', async () => {
  await assert.rejects(prepareRunDataRoot(undefined, variable), /CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT.*C:\\cwr.*Windows MAX_PATH/u);
  await assert.rejects(prepareRunDataRoot('  ', variable), /must name a short directory/u);
  const long = join(tmpdir(), 'x'.repeat(runDataRootMaxCharacters));
  await assert.rejects(prepareRunDataRoot(long, variable), /at most 40 characters/u);
  assert.equal(await exists(long), false, 'A refused root is never created.');
});

test('concurrent setups claim separate roots and leave sibling files and runs alone', async () => {
  const root = await temporaryDirectory('run-data-');
  await writeFile(join(root, 'kept.txt'), 'kept');
  const [first, second] = await Promise.all([
    prepareRunDataRoot(root, variable, 1_000),
    prepareRunDataRoot(root, variable, 1_000),
  ]);
  assert.notEqual(first.root, second.root);
  assert.equal(await removeRunDataRoot(first), true);
  assert.equal(await exists(second.appData), true);
  assert.equal(await removeRunDataRoot(second), true);
  assert.deepEqual(await readdir(root), ['kept.txt']);
});

test('only the parents mkdir created are claimed, whatever form mkdir reports them in', () => {
  const root = join(tmpdir(), 'kept-root');
  const parent = join(root, 'nested', 'parent');
  const created = [parent, join(root, 'nested')];
  assert.deepEqual(createdParents(parent, join(root, 'nested')), created);
  if (process.platform === 'win32') {
    // Node on Windows reports the first created directory with a \\?\ prefix.
    assert.deepEqual(createdParents(parent, `\\\\?\\${join(root, 'nested')}`), created);
    assert.deepEqual(createdParents(parent, join(root, 'nested').toUpperCase()), created);
  }
  assert.deepEqual(createdParents(parent, undefined), []);
  // An empty path would resolve to the working directory; it claims nothing.
  assert.deepEqual(createdParents(parent, ''), []);
  // A reported directory that is not an ancestor claims nothing, so nothing above is removed.
  assert.deepEqual(createdParents(parent, join(tmpdir(), 'elsewhere')), []);
});

test('a failure creating local app data removes the partially initialized run directory', async () => {
  const root = await temporaryDirectory('run-data-');
  for (const parent of [root, join(root, 'nested', 'parent')]) {
    await assert.rejects(prepareRunDataRoot(parent, variable, 1_000, async (path) => {
      if (path.endsWith('local-app-data')) throw new Error('Synthetic setup failure.');
      await mkdir(path);
    }), /Synthetic setup failure/u);
    assert.deepEqual(await readdir(root), []);
  }
});

test('the run data root holds the app data and local app data the app is pointed at, and goes away whole', async () => {
  const root = join(await temporaryDirectory('run-data-'), 'run');
  const run = await prepareRunDataRoot(root, variable, 1_000);
  assert.deepEqual((await readdir(run.root)).sort(), ['app-data', 'local-app-data']);
  assert.deepEqual(runDataEnvironment(run), {
    APPDATA: run.appData,
    LOCALAPPDATA: run.localAppData,
    CAPTURE_ACCEPTANCE_APP_DATA_ROOT: run.appData,
    E2E_ARTIFACT_ROOT: run.root,
  });
  await mkdir(join(run.appData, 'runtime', 'engines'), { recursive: true });
  await writeFile(join(run.appData, 'runtime', 'engines', 'active.json'), '{}');
  assert.equal(await removeRunDataRoot(run), true);
  assert.equal(await exists(run.root), false);
  assert.deepEqual(await readdir(root), []);
});

test('removing the run data root reports what the run did not create', async () => {
  const root = join(await temporaryDirectory('run-data-'), 'run');
  const run = await prepareRunDataRoot(root, variable, 1_000);
  await writeFile(join(run.root, 'someone-else.txt'), 'kept');
  assert.equal(await removeRunDataRoot(run), false);
  assert.deepEqual(await readdir(run.root), ['someone-else.txt']);
});

test('process cleanup requires a complete inventory that excludes every previously observed PID', () => {
  const observed = new Set([10, 20, 30]);
  const emptyTree = { livePids: [1], descendants: [] };
  assert.equal(ownedProcessCleanupFailure(observed, emptyTree, false), undefined);
  const incomplete = 'Owned Capture Workbench process inventory was incomplete.';
  assert.equal(ownedProcessCleanupFailure(observed, undefined, false), incomplete);
  assert.equal(ownedProcessCleanupFailure(observed, emptyTree, true), incomplete);
  const survivor = 'Owned Capture Workbench processes remained after teardown.';
  assert.equal(ownedProcessCleanupFailure(observed, { ...emptyTree, livePids: [1, 30] }, false), survivor);
  const descendant = { pid: 40, name: 'synthetic-worker', commandLine: '' };
  assert.equal(ownedProcessCleanupFailure(observed, { livePids: [1, 40], descendants: [descendant] }, false), survivor);
});

test('the WebView2 debugging endpoint listens on loopback only', () => {
  assert.equal(
    desktopCdpArguments(41_234),
    '--remote-debugging-address=127.0.0.1 --remote-debugging-port=41234 --remote-allow-origins=*',
  );
});
