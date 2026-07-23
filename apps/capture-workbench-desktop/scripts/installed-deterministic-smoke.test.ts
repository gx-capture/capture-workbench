import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertInstalledSmokeEvidence,
  assertInstallationCleanupAllowed,
  assertCaptureDocumentForFixture,
  assertRegistryOwnership,
  assertStrictDescendant,
  assertTaskkillResult,
  acquireExclusiveSmokeLock,
  buildInstalledAppEnvironment,
  installerArguments,
  releaseExclusiveSmokeLock,
  uninstallerArguments,
} from './installed-deterministic-smoke.ts';
import { appRoot } from './stage-runtime.ts';

function observe(observable) {
  return new Promise((resolve, reject) => {
    let value;
    observable.subscribe({
      next: (nextValue) => {
        value = nextValue;
      },
      error: reject,
      complete: () => resolve(value),
    });
  });
}

test('installed smoke paths and NSIS arguments stay inside the exact tmp subtree', () => {
  const root = resolve(
    appRoot,
    '..',
    '..',
    'tmp',
    'capture-workbench-desktop',
    'installed-smoke',
  );
  const install = join(root, 'run', 'install');
  assert.equal(assertStrictDescendant(root, install), install);
  assert.deepEqual(installerArguments(root, install), [
    '/S',
    '/NS',
    `/D=${install}`,
  ]);
  assert.deepEqual(uninstallerArguments(root, install), ['/S']);
  assert.throws(() => assertStrictDescendant(root, root), /strict descendant/u);
  assert.throws(
    () => assertStrictDescendant(root, resolve(root, '..', 'escaped')),
    /strict descendant/u,
  );
  assert.throws(
    () => installerArguments(root, resolve(root, '..', 'other-product')),
    /strict descendant/u,
  );
});

test('installed app environment is process-scoped, isolated, and drops ambient secrets', () => {
  const root = resolve(
    appRoot,
    '..',
    '..',
    'tmp',
    'capture-workbench-desktop',
    'installed-smoke',
    'run',
  );
  const environment = buildInstalledAppEnvironment(
    {
      PATH: 'safe-path',
      SystemRoot: 'C:\\Windows',
      GITHUB_TOKEN: 'must-not-propagate',
      CAPTURE_API_TOKEN: 'must-not-propagate',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--persisted-unsafe-value',
    },
    {
      root,
      appData: join(root, 'appdata'),
      localAppData: join(root, 'localappdata'),
      temporary: join(root, 'temp'),
      webViewData: join(root, 'webview2'),
    },
    43_219,
  );

  assert.equal(environment.PATH, 'safe-path');
  assert.equal(environment.SYSTEMROOT, 'C:\\Windows');
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.CAPTURE_API_TOKEN, undefined);
  assert.equal(
    environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    '--remote-debugging-address=127.0.0.1 --remote-debugging-port=43219 --remote-allow-origins=*',
  );
  assert.equal(environment.WEBVIEW2_USER_DATA_FOLDER, join(root, 'webview2'));
});

test('registry cleanup is allowed only for the exact owned install directory', () => {
  const owned = resolve(
    appRoot,
    '..',
    '..',
    'tmp',
    'capture-workbench-desktop',
    'installed-smoke',
    'run',
    'install',
  );
  assert.doesNotThrow(() =>
    assertRegistryOwnership(`"${owned}"`, owned, 'Owned registry key'),
  );
  assert.throws(
    () =>
      assertRegistryOwnership(
        resolve(owned, '..', 'concurrent-install'),
        owned,
        'Owned registry key',
      ),
    /no longer belongs/u,
  );
  assert.throws(
    () =>
      assertRegistryOwnership('relative-install', owned, 'Owned registry key'),
    /absolute install path/u,
  );
});

test('nonzero taskkill status is accepted only after the exact owned PID is gone', () => {
  assert.doesNotThrow(() =>
    assertTaskkillResult({ status: 128, error: undefined }, false),
  );
  assert.throws(
    () => assertTaskkillResult({ status: 128, error: undefined }, true),
    /status 128 while the PID remained owned/u,
  );
  assert.throws(
    () =>
      assertTaskkillResult(
        { status: null, error: new Error('spawn failed') },
        true,
      ),
    /could not run/u,
  );
});

test('uninstall and recursive cleanup fail closed until owned processes are proven stopped', () => {
  assert.doesNotThrow(() => assertInstallationCleanupAllowed(true));
  assert.throws(
    () => assertInstallationCleanupAllowed(false),
    /without proving all owned processes stopped/u,
  );
  assert.throws(
    () => assertInstallationCleanupAllowed(undefined),
    /without proving all owned processes stopped/u,
  );
});

test('exclusive smoke lock rejects concurrent product mutation and is reusable after release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'capture-installed-smoke-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, 'installed-smoke.lock');
  const first = await observe(acquireExclusiveSmokeLock(root, lockPath));
  await assert.rejects(
    observe(acquireExclusiveSmokeLock(root, lockPath)),
    /active or left a stale lock/u,
  );
  await observe(releaseExclusiveSmokeLock(first));
  const second = await observe(acquireExclusiveSmokeLock(root, lockPath));
  await observe(releaseExclusiveSmokeLock(second));
});

test('installed document assertion enforces source, digest, ordering, and locator provenance', () => {
  const pageFixture = captureFixture('page');
  const pageDocument = captureDocument(pageFixture);
  assert.doesNotThrow(() =>
    assertCaptureDocumentForFixture(pageDocument, pageFixture),
  );

  assert.throws(
    () =>
      assertCaptureDocumentForFixture(
        {
          ...pageDocument,
          source: { ...pageDocument.source, sha256: '0'.repeat(64) },
        },
        pageFixture,
      ),
    /Expected values to be strictly equal/u,
  );
  assert.throws(
    () =>
      assertCaptureDocumentForFixture(
        {
          ...pageDocument,
          blocks: [
            { ...pageDocument.blocks[0], sourceSegmentId: 'wrong-segment' },
          ],
        },
        pageFixture,
      ),
    /Expected values to be strictly equal/u,
  );

  const timeFixture = captureFixture('time');
  const timeDocument = captureDocument(timeFixture);
  assert.doesNotThrow(() =>
    assertCaptureDocumentForFixture(timeDocument, timeFixture),
  );
  assert.throws(
    () =>
      assertCaptureDocumentForFixture(
        {
          ...timeDocument,
          rawSegments: [
            {
              ...timeDocument.rawSegments[0],
              locator: { kind: 'time', startMs: 1000, endMs: 1000 },
            },
          ],
        },
        timeFixture,
      ),
    /Expected values to be strictly equal/u,
  );
});

test('installed evidence is permanently deterministic, redacted, and path-free', () => {
  const valid = {
    evidenceKind: 'deterministic-installed-tauri-smoke',
    releaseGateSatisfied: false,
    realEnginesExercised: false,
    disclaimer:
      'Deterministic verification only; it does not satisfy release gates.',
  };
  assert.doesNotThrow(() => assertInstalledSmokeEvidence(valid));
  assert.throws(
    () =>
      assertInstalledSmokeEvidence({ ...valid, releaseGateSatisfied: true }),
    /non-releaseable/u,
  );
  assert.throws(
    () =>
      assertInstalledSmokeEvidence({ ...valid, realEnginesExercised: true }),
    /non-releaseable/u,
  );
  assert.throws(
    () =>
      assertInstalledSmokeEvidence({
        ...valid,
        installer: 'C:\\outside\\setup.exe',
      }),
    /absolute Windows paths/u,
  );
  assert.throws(
    () =>
      assertInstalledSmokeEvidence({
        ...valid,
        authorization: 'Bearer unsafe',
      }),
    /authorization material/u,
  );
});

test('Nx target depends on the deterministic NSIS build and writes only non-release evidence', async () => {
  const project = JSON.parse(
    await readFile(join(appRoot, 'project.json'), 'utf8'),
  );
  const target = project.targets['smoke-installed-deterministic'];
  assert.deepEqual(target.dependsOn, ['build-nsis-deterministic']);
  assert.equal(target.cache, false);
  assert.match(
    target.metadata.description,
    /excluded from ordinary verify and CI/u,
  );
  assert.deepEqual(target.outputs, [
    '{workspaceRoot}/tmp/capture-workbench-desktop/installed-smoke/installed-smoke.json',
  ]);
  assert.match(target.options.command, /installed-deterministic-smoke\.ts/u);
});

function captureFixture(locatorKind) {
  const sourceKind = locatorKind === 'time' ? 'audio' : 'image';
  const fileName = locatorKind === 'time' ? 'fixture.wav' : 'fixture.png';
  const mimeType = locatorKind === 'time' ? 'audio/wav' : 'image/png';
  const expectedTexts = ['fixture words'];
  return {
    sourceKind,
    fileName,
    mimeType,
    buffer: Buffer.from(`fixture-${locatorKind}`, 'utf8'),
    locatorKind,
    expectedSegments: 1,
    expectedTexts,
  };
}

function captureDocument(fixture) {
  const locator =
    fixture.locatorKind === 'time'
      ? { kind: 'time', startMs: 0, endMs: 1000 }
      : { kind: 'page', page: 1 };
  const rawSegments = [
    {
      segmentId: 'segment-1',
      order: 0,
      locator,
      text: fixture.expectedTexts[0],
    },
  ];
  const blocks = [
    {
      blockId: 'block-1',
      order: 0,
      sourceSegmentId: 'segment-1',
      type: fixture.locatorKind === 'time' ? 'transcript' : 'paragraph',
      locator,
      sourceText: fixture.expectedTexts[0],
      targetText: `[zh-Hant] ${fixture.expectedTexts[0]}`,
    },
  ];
  const engine = {
    engine: 'deterministic-engine',
    model: 'deterministic-model',
    digest: `sha256:${'a'.repeat(64)}`,
    device: 'fake',
  };
  return {
    schemaVersion: '1',
    source: {
      sha256: createHash('sha256').update(fixture.buffer).digest('hex'),
      fileName: fixture.fileName,
      mediaType: fixture.mimeType,
      bytes: fixture.buffer.length,
    },
    rawSegments,
    blocks,
    sourceText: fixture.expectedTexts.join('\n'),
    targetText: blocks.map((block) => block.targetText).join('\n'),
    extractionEngine: engine,
    structuringEngine: { ...engine, engine: 'deterministic-structurer' },
    warnings: [],
    createdAt: '2026-07-22T00:00:00Z',
    completedAt: '2026-07-22T00:00:01Z',
  };
}
