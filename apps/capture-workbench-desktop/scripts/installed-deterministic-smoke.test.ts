import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { of } from 'rxjs';

import {
  assertInstalledSmokeEvidence,
  assertInstallationCleanupAllowed,
  assertCaptureDocumentForFixture,
  assertRegistryOwnership,
  assertStrictDescendant,
  assertTaskkillResult,
  acquireExclusiveSmokeLock,
  buildInstalledAppEnvironment,
  installedSmokeDiagnosticMessageLimit,
  installedSmokeDiagnosticRedactionMarker,
  installedSmokeExecutableTimeoutMs,
  installerArguments,
  nestedErrorMessages,
  releaseExclusiveSmokeLock,
  runInstalledDeterministicSmoke,
  uninstallerArguments,
} from './installed-deterministic-smoke.ts';
import { expectedInstallerName } from './installed-smoke-lifecycle.ts';
import {
  formatInstalledWebViewStartupDiagnostics,
  installedWebViewCdpReadyTimeoutMs,
  parseInstalledWebViewCdpPort,
} from './installed-browser.ts';
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

test('installed measurement derives the exact installer name from release metadata', () => {
  assert.equal(
    expectedInstallerName('0.3.8'),
    'Capture Workbench_0.3.8_x64-setup.exe',
  );
  assert.throws(() => expectedInstallerName('0.3.8-beta'), /semantic x\.y\.z/u);
});

test('release size dispatch returns before the installed app observer lane', async () => {
  let sizeCalls = 0;
  let observerConstructions = 0;
  const expected = { reportPath: 'installed-size.json' };
  const result = await observe(
    runInstalledDeterministicSmoke(
      { expectedSource: 'release', measureOnly: true },
      {
        runSizeMeasurement: () => {
          sizeCalls += 1;
          return of(expected);
        },
        createProcessCleanup: () => {
          observerConstructions += 1;
          throw new Error('Full Tauri/observer lane must not be constructed.');
        },
      },
    ),
  );

  assert.deepEqual(result, expected);
  assert.equal(sizeCalls, 1);
  assert.equal(observerConstructions, 0);
});

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
      Cuda_Path: 'cuda-toolkit-root',
      GITHUB_TOKEN: 'must-not-propagate',
      CAPTURE_API_TOKEN: 'must-not-propagate',
      CAPTURE_EXTRACTION_PROVIDER: 'must-not-propagate',
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
  assert.equal(environment.CUDA_PATH, 'cuda-toolkit-root');
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.CAPTURE_API_TOKEN, undefined);
  assert.equal(environment.CAPTURE_EXTRACTION_PROVIDER, undefined);
  assert.equal(
    environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    '--remote-debugging-address=127.0.0.1 --remote-debugging-port=43219 --remote-allow-origins=*',
  );
  assert.equal(environment.WEBVIEW2_USER_DATA_FOLDER, join(root, 'webview2'));

  const dynamicEnvironment = buildInstalledAppEnvironment(
    {},
    {
      root,
      appData: join(root, 'appdata'),
      localAppData: join(root, 'localappdata'),
      temporary: join(root, 'temp'),
      webViewData: join(root, 'webview2'),
    },
    0,
  );
  assert.equal(
    dynamicEnvironment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    '--remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --remote-allow-origins=*',
  );
});

test('installed WebView2 dynamic CDP metadata accepts only a valid port', () => {
  assert.equal(
    parseInstalledWebViewCdpPort(
      '62086\r\n/devtools/browser/test-guid\r\n',
    ),
    62_086,
  );
  assert.throws(
    () => parseInstalledWebViewCdpPort('0\n/devtools/browser/test-guid\n'),
    /valid CDP port/u,
  );
  assert.throws(
    () => parseInstalledWebViewCdpPort('not-a-port\n'),
    /valid CDP port/u,
  );
});

test('installed WebView2 startup diagnostics expose only safe bounded facts', () => {
  const message = formatInstalledWebViewStartupDiagnostics({
    appRunning: true,
    appOsProcess: true,
    webViewRuntimeInstalled: true,
    webViewProcessCount: 2,
    webViewRemoteDebuggingArgument: false,
    webViewUserDataArgument: true,
    requestedPortListening: false,
    devToolsActivePortFile: false,
    path: 'must-not-appear',
  });
  assert.equal(
    message,
    'Installed WebView2 startup diagnostics: appRunning=true;appOsProcess=true;webViewRuntimeInstalled=true;webViewProcessCount=2;webViewRemoteDebuggingArgument=false;webViewUserDataArgument=true;requestedPortListening=false;devToolsActivePortFile=false.',
  );
  assert.equal(message.includes('must-not-appear'), false);
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

test('installed smoke diagnostics recursively expose the nested cleanup cause', () => {
  const cleanupCause = new Error(
    'Owned installed app/runtime processes remained after tree cleanup.',
  );
  const rootFailure = new AggregateError(
    [
      new AggregateError(
        [cleanupCause],
        'One or more installed-smoke process roots could not be cleaned safely.',
      ),
    ],
    'Installed deterministic Tauri smoke failed or could not clean up safely.',
  );

  assert.deepEqual(nestedErrorMessages(rootFailure), [
    'Installed deterministic Tauri smoke failed or could not clean up safely.',
    'One or more installed-smoke process roots could not be cleaned safely.',
    'Owned installed app/runtime processes remained after tree cleanup.',
  ]);
});

test('installed smoke diagnostics redact nested paths and secrets while retaining safe causes', () => {
  const absoluteWindowsPathDiagnostics = [
    ['spawn failed for C:\\Users\\Alice\\Capture\\runtime.exe', 'C:\\Users\\Alice\\Capture\\runtime.exe'],
    ['spawn failed for D:/Users/Alice/Capture/runtime.exe', 'D:/Users/Alice/Capture/runtime.exe'],
    ['cleanup failed for \\\\server01\\private-share\\cleanup.ps1', '\\\\server01\\private-share\\cleanup.ps1'],
    ['cleanup failed for \\Users\\Alice\\Capture\\cleanup.ps1', '\\Users\\Alice\\Capture\\cleanup.ps1'],
    ['cleanup failed for /Users/Alice/Capture/cleanup.ps1', '/Users/Alice/Capture/cleanup.ps1'],
    ['failed:C:\\Users\\Alice\\x.txt', 'C:\\Users\\Alice\\x.txt'],
    ['file:///C:/Users/Alice/x.txt', 'C:/Users/Alice/x.txt'],
    ['prefix\\\\server\\share\\x.txt', '\\\\server\\share\\x.txt'],
    ['failed:\\Users\\Alice\\x.txt', '\\Users\\Alice\\x.txt'],
    ['failed:/Users/Alice/x.txt', '/Users/Alice/x.txt'],
  ];
  const sensitiveDiagnostics = [
    ['GITHUB_TOKEN', 'github-value-that-must-never-appear'],
    ['NODE_AUTH_TOKEN', 'node-value-that-must-never-appear'],
    ['refresh_token', 'refresh-value-that-must-never-appear'],
    ['accessToken', 'access-value-that-must-never-appear'],
    ['apiToken', 'api-value-that-must-never-appear'],
    ['authorization', 'authorization-value-that-must-never-appear'],
    ['bearer', 'bearer-value-that-must-never-appear'],
    ['secret', 'secret-value-that-must-never-appear'],
    ['secretToken', 'secret-token-value-that-must-never-appear'],
    ['BeArEr', 'mixed-bearer-value-that-must-never-appear'],
    ['ToKeN', 'mixed-token-value-that-must-never-appear'],
    ['SeCrEt', 'mixed-secret-value-that-must-never-appear'],
    ['AuThOrIzAtIoN', 'mixed-authorization-value-that-must-never-appear'],
    ['GiThUb_ToKeN', 'mixed-github-value-that-must-never-appear'],
    ['aPiToKeN', 'mixed-api-value-that-must-never-appear'],
    ['SeCrEtToKeN', 'mixed-secret-token-value-that-must-never-appear'],
  ] as const;
  const safeCause =
    'Owned installed app/runtime processes remained after tree cleanup.';
  const rootFailure = new AggregateError(
    [
      ...absoluteWindowsPathDiagnostics.map(
        ([message]) => new Error(message),
      ),
      new AggregateError(
        [
          new Error(safeCause),
          ...sensitiveDiagnostics.map(
            ([label, value], index) =>
              new Error(
                index % 3 === 0
                  ? `${label}: ${value}`
                  : index % 3 === 1
                    ? `${label} = ${value}`
                    : `${label} ${value}`,
              ),
          ),
        ],
        'PowerShell cleanup collected nested failures.',
      ),
      new Error('bounded-safe-detail-'.repeat(80)),
    ],
    'Installed deterministic Tauri smoke failed or could not clean up safely.',
  );

  const messages = nestedErrorMessages(rootFailure);
  const output = messages.join('\n');
  assert.ok(messages.includes(safeCause));
  assert.ok(messages.includes(installedSmokeDiagnosticRedactionMarker));
  for (const [message, path] of absoluteWindowsPathDiagnostics) {
    assert.equal(output.includes(message), false, message);
    assert.equal(output.includes(path), false, path);
  }
  for (const [label, value] of sensitiveDiagnostics) {
    assert.equal(output.toLowerCase().includes(label.toLowerCase()), false, label);
    assert.equal(output.includes(value), false, value);
  }
  assert.ok(
    messages.every(
      (message) => message.length <= installedSmokeDiagnosticMessageLimit,
    ),
  );
  assert.ok(messages.some((message) => message.endsWith('...')));
});

test('installed smoke diagnostics retain safe error context when redacting paths', () => {
  const messages = nestedErrorMessages(
    new Error('Installed NSIS uninstaller failed for C:\\runner\\temp\\install'),
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Installed NSIS uninstaller failed/u);
  assert.equal(messages[0].includes('C:\\runner\\temp\\install'), false);
  assert.match(messages[0], /redacted unsafe diagnostic/u);
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

test('installed smoke gives model-enabled hosted runners enough time to unpack the payload', () => {
  assert.equal(installedSmokeExecutableTimeoutMs, 600_000);
});

test('installed smoke gives hosted WebView2 enough time to expose CDP', () => {
  assert.equal(installedWebViewCdpReadyTimeoutMs, 180_000);
});

test('installed smoke verifies the v2 bundled Ollama model', async () => {
  const source = await readFile(
    join(appRoot, 'scripts', 'installed-browser.ts'),
    'utf8',
  );
  assert.match(source, /qwen\(\?:3\\\.5:/u);
  assert.doesNotMatch(source, /qwen3\\.5:4b/u);
});

test('installed smoke exercises the desktop native source picker', async () => {
  const source = await readFile(
    join(appRoot, 'scripts', 'installed-browser.ts'),
    'utf8',
  );
  assert.match(source, /nativeOpenDialogUiAutomation\(/u);
  assert.match(source, /page\.getByTestId\('source-import'\)/u);
});

test('post-uninstall cleanup tolerates the owned install root being removed', async () => {
  const source = await readFile(
    join(appRoot, 'scripts', 'installed-deterministic-smoke.ts'),
    'utf8',
  );
  const postUninstallCleanup = source.slice(
    source.indexOf('registry.waitForInstalledDirectoryRemoval(installDirectory)'),
    source.indexOf('concatMap(() =>\n          state.cleanup.ownedProcessesStopped'),
  );
  assert.match(
    postUninstallCleanup,
    /stopAndProveResidualProcessRoots\(\[installDirectory\]\)/u,
  );
  assert.match(
    postUninstallCleanup,
    /stopAndProveOwnedProcessRoots\(\[\s*temporaryDirectory,\s*\]\)/u,
  );
});

test('release installed smoke verifies the packaged shell without auto-installing runtime requirements', async () => {
  const source = await readFile(
    join(appRoot, 'scripts', 'installed-deterministic-smoke.ts'),
    'utf8',
  );
  assert.match(
    source,
    /expectedSource === 'release'[\s\S]+model: 'setup-pending'[\s\S]+captures: \[\]/u,
  );
  assert.match(
    source,
    /expectedSource === 'release'[\s\S]+: exerciseInstalledUi\(\s*page,/u,
  );
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
    schemaVersion: '2',
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
