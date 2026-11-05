// eslint-disable-next-line @nx/enforce-module-boundaries -- shared test temp-root guard.
import '../../../tools/test-temp-root.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  buildInstalledSmokeFailureReport,
  writeSmokeFailureReport,
  installedAppExerciseError,
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
import { trackSmokeStep } from './smoke-diagnostics.ts';
import type { SmokeStepEvent } from './smoke-diagnostics.ts';
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
  assert.equal(
    expectedInstallerName('0.3.8', 'Capture Workbench QA Fake Data'),
    'Capture Workbench QA Fake Data_0.3.8_x64-setup.exe',
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
      CAPTURE_ACCEPTANCE_APP_DATA_ROOT: 'must-not-propagate',
      E2E_ARTIFACT_ROOT: 'must-not-propagate',
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

  assert.equal(environment.CAPTURE_ACCEPTANCE_APP_DATA_ROOT, join(root, 'artifacts', 'appdata'));
  assert.equal(environment.E2E_ARTIFACT_ROOT, join(root, 'artifacts'));
  assert.equal(environment.PATH, 'safe-path');
  assert.equal(environment.SYSTEMROOT, 'C:\\Windows');
  assert.equal(environment.CUDA_PATH, 'cuda-toolkit-root');
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.CAPTURE_API_TOKEN, undefined);
  assert.equal(environment.CAPTURE_EXTRACTION_PROVIDER, undefined);
  assert.equal(
    environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    '--remote-debugging-port=43219',
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
    '--remote-debugging-port=0',
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

test('installed exercise diagnostics retain a later capture failure without labeling it a startup failure', () => {
  const captureError = new Error('Installed pdf capture did not complete.');
  const diagnostics = formatInstalledWebViewStartupDiagnostics({ appRunning: true });
  const failure = installedAppExerciseError(captureError, diagnostics);
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors[0], captureError);
  assert.deepEqual(nestedErrorMessages(failure), [
    'Installed app exercise failed.',
    captureError.message,
    diagnostics,
  ]);
  assert.equal(installedAppExerciseError(captureError), captureError);
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


test('failure report includes timeline, causes, WebView diagnostics, cards and safe request lines', () => {
  const timestamp = '2026-11-05T01:02:03.000Z';
  const report = buildInstalledSmokeFailureReport({
    timestamp,
    error: new AggregateError([
      new Error('Capture failed.', { cause: new Error('Runtime refused chunk.') }),
      new Error('Bearer private-credential'),
    ], 'Installed smoke failed.'),
    timeline: [{ step: 'completion wait', timestamp, outcome: 'failed' }],
    webViewDiagnostics: 'appRunning=true; userData=C:\\private-user\\webview',
    cardDiagnostics: [{ fileName: 'fixture.pdf', status: 'failed', detailErrors: ['chunk_conflict', 'token=private-credential'] }],
    requestLogLines: [JSON.stringify({
      timestamp: 123, method: 'POST', route: '/v2/ingestions/{ingestionId}/finalize',
      status: 409, errorCode: 'ingestion_finalize_rejected',
      headers: { authorization: 'Bearer private-credential' }, body: 'private-body',
    }), JSON.stringify({ method: 'GET', route: 'C:\\private-user\\log', status: 500 }), 'malformed private-credential'],
  });
  assert.deepEqual(report.errors.slice(0, 3), ['Installed smoke failed.', 'Capture failed.', 'Runtime refused chunk.']);
  assert.equal(report.timeline.find((event) => event.step === 'completion wait').outcome, 'failed');
  assert.equal(report.timeline.find((event) => event.step === 'source picker').outcome, 'skipped');
  assert.equal(report.timeline.length, 7);
  assert.equal(report.cardDiagnostics[0].status, 'failed');
  assert.equal(report.cardDiagnostics[0].detailErrors[0], 'chunk_conflict');
  const line = JSON.parse(report.requestLogLines[0]);
  assert.equal(line.route, '/v2/ingestions/{ingestionId}/finalize');
  assert.equal(line.errorCode, 'ingestion_finalize_rejected');
  assert.equal(line.headers, undefined);
  assert.match(report.webViewDiagnostics, /appRunning=true/u);
  const serialized = JSON.stringify(report);
  for (const value of ['private-credential', 'private-user', 'private-body', 'authorization']) {
    assert.equal(serialized.includes(value), false, value);
  }
});

test('step timeline records synchronous failure and successful completion', async () => {
  const timeline: SmokeStepEvent[] = [];
  await observe(trackSmokeStep(timeline, 'install', () => of(undefined)));
  await assert.rejects(observe(trackSmokeStep(timeline, 'launch', () => { throw new Error('launch failed'); })), /launch failed/u);
  assert.deepEqual(timeline.map(({ step, outcome }) => [step, outcome]), [
    ['install', 'started'], ['install', 'passed'], ['launch', 'started'], ['launch', 'failed'],
  ]);
  for (const event of timeline) assert.ok(Number.isFinite(Date.parse(event.timestamp)));
});

test('failure report retention keeps three newest reports and preserves unrelated evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'capture-installed-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'installed-smoke.json'), 'success evidence');
  await writeFile(join(root, 'installed-smoke-failure-not-a-timestamp.json'), 'unrelated');
  const directoryName = 'installed-smoke-failure-2020-01-01T00-00-00-000Z.json';
  await mkdir(join(root, directoryName));
  const report = buildInstalledSmokeFailureReport({ error: new Error('Failed safely.') });
  const paths: string[] = [];
  // Write out of time order so retention must use timestamp, not directory order.
  for (const day of [5, 1, 4, 2, 3]) {
    paths.push(await writeSmokeFailureReport(root, report, 'installed-smoke-failure', new Date(`2026-11-0${day}T00:00:00.000Z`)));
  }
  const names = await readdir(root);
  for (const day of [3, 4, 5]) assert.ok(names.includes(`installed-smoke-failure-2026-11-0${day}T00-00-00-000Z.json`));
  for (const day of [1, 2]) assert.equal(names.includes(`installed-smoke-failure-2026-11-0${day}T00-00-00-000Z.json`), false);
  assert.equal(await readFile(join(root, 'installed-smoke.json'), 'utf8'), 'success evidence');
  assert.ok(names.includes('installed-smoke-failure-not-a-timestamp.json'));
  assert.ok(names.includes(directoryName));
  assert.deepEqual(JSON.parse(await readFile(paths[0], 'utf8')), report);
});

test('request-log environment accepts an explicit isolated TEMP destination only', () => {
  const root = resolve(appRoot, '..', '..', 'tmp', 'installed-log-environment-test');
  const directories = {
    root, appData: join(root, 'appdata'), localAppData: join(root, 'localappdata'),
    temporary: join(root, 'temp'), webViewData: join(root, 'webview2'),
  };
  const requestLog = join(directories.temporary, 'requests.jsonl');
  const source = { CAPTURE_DETERMINISTIC_REQUEST_LOG: 'ambient-log-must-not-propagate' };
  assert.equal(buildInstalledAppEnvironment(source, directories, 0).CAPTURE_DETERMINISTIC_REQUEST_LOG, undefined);
  assert.equal(buildInstalledAppEnvironment(source, { ...directories, requestLog }, 0).CAPTURE_DETERMINISTIC_REQUEST_LOG, requestLog);
  assert.throws(() => buildInstalledAppEnvironment(source, { ...directories, requestLog: join(root, 'outside-temp.jsonl') }, 0), /strict descendant/u);
});


test('isolation failure reports include only real app-data metadata and the failed comparison', () => {
  const before = { directoryExists: true, libraryExists: true, index: { mtimeNs: '100', bytes: '20' } };
  const after = { ...before, index: { mtimeNs: '101', bytes: '20' } };
  const report = buildInstalledSmokeFailureReport({
    error: new Error('Real product app-data changed during the installed smoke. Isolation failed.'),
    realAppDataGuard: { status: 'failed', before, after },
  });
  assert.deepEqual(report.realAppDataGuard, { status: 'failed', before, after });
  assert.ok(report.errors.some((message) => message.includes('Real product app-data changed')));
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:[\\/]/u);
});
