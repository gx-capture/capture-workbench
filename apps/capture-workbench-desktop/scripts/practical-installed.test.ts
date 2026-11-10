// eslint-disable-next-line @nx/enforce-module-boundaries -- shared test temp-root guard.
import '../../../tools/test-temp-root.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- repository tooling reads shared release intent.
import { RELEASE_VERSION } from '../../../tools/release/release-intent.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseBuildArguments } from './build-practical-installer.ts';
import {
  RUNTIME_CATALOG_NAME,
  RUNTIME_EXECUTABLE_NAME,
  RUNTIME_MANIFEST_NAME,
  RUNTIME_SCHEMA_NAME,
  assertNsisTargetsOnlyVariant,
  assertPracticalEvidence,
  assertPracticalProvenance,
  assertRuntimeReleaseMatchesMode,
  ownedProcessImages,
  parseRunArguments,
  practicalChildEnvironment,
  practicalKnownFolderRoots,
  practicalRegistryKeys,
  practicalVariant,
  readVerifiedWorkerFiles,
  sha256Hex,
  verifyRuntimeReleaseDirectory,
  type PracticalOcrEvidence,
} from './practical-installed.ts';

const variant = practicalVariant('r20260924a');
const RELEASE_DOWNLOAD = `https://github.com/gx-capture/capture-workbench/releases/download/v${RELEASE_VERSION}`;
const SPEECH_ARCHIVE = `capture-engine-speech-recognition-${RELEASE_VERSION}-windows-x64.zip`;
const SPEECH_PARTS = [Buffer.from('speech worker part one'), Buffer.from('speech worker part two')];
const sha = (seed: string) => sha256Hex(Buffer.from(seed));

test('practical variant changes only the Tauri identity triple and derived keys', () => {
  assert.deepEqual(
    { identifier: variant.identifier, productName: variant.productName, mainBinaryName: variant.mainBinaryName },
    {
      identifier: 'io.github.gx-capture.cw-practical-r20260924a',
      productName: 'Capture Workbench Practical r20260924a',
      mainBinaryName: 'capture-workbench-practical-r20260924a',
    },
  );
  assert.equal(
    practicalRegistryKeys(variant).uninstallRegistryKey,
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Capture Workbench Practical r20260924a',
  );
  for (const bad of ['short', 'UPPERCASE123', 'has-dash-123', '../escape123', 'a'.repeat(17)]) {
    assert.throws(() => practicalVariant(bad), /run ID/u);
  }
});

function nsisScript(overrides: Record<string, string> = {}, extra = ''): string {
  const defines = {
    MANUFACTURER: 'github',
    PRODUCTNAME: variant.productName,
    MAINBINARYNAME: variant.mainBinaryName,
    MAINBINARYSRCPATH: 'C:\\build\\target\\release\\capture-workbench-desktop.exe',
    BUNDLEID: variant.identifier,
    ...overrides,
  };
  return [
    ...Object.entries(defines).map(([name, value]) => `!define ${name} "${value}"`),
    '!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCTNAME}"',
    'Name "${PRODUCTNAME}"',
    'nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"',
    extra,
  ].join('\r\n');
}

test('generated NSIS must target only the practical variant', () => {
  assert.doesNotThrow(() => assertNsisTargetsOnlyVariant(nsisScript(), variant));
  assert.doesNotThrow(() =>
    assertNsisTargetsOnlyVariant(nsisScript({}, 'Caption "Capture Workbench Practical r20260924a Setup"'), variant),
  );
  assert.throws(
    () => assertNsisTargetsOnlyVariant(nsisScript({ PRODUCTNAME: 'Capture Workbench' }), variant),
    /PRODUCTNAME/u,
  );
  assert.throws(
    () => assertNsisTargetsOnlyVariant(nsisScript({ BUNDLEID: 'io.github.gx-capture.capture-workbench' }), variant),
    /BUNDLEID/u,
  );
  for (const leak of [
    'nsis_tauri_utils::KillProcess "capture-workbench-desktop.exe"',
    'ReadRegStr $0 HKCU "Software\\github\\Capture Workbench" ""',
    'StrCpy $1 "io.github.gx-capture.capture-workbench"',
    'Caption "Capture Workbench Practical other1234"',
  ]) {
    assert.throws(() => assertNsisTargetsOnlyVariant(nsisScript({}, leak), variant), /ordinary Capture Workbench/u);
  }
  assert.throws(
    () => assertNsisTargetsOnlyVariant(`${nsisScript()}\r\n!define PRODUCTNAME "Capture Workbench"`, variant),
    /redefines PRODUCTNAME/u,
  );
});

async function releaseFixture(mutate: (files: Map<string, Buffer>) => void = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'practical-release-'));
  const executable = Buffer.from('runtime executable bytes');
  const schema = Buffer.from('{"schema":true}');
  const worker = Buffer.from('ocr worker archive');
  const manifest = {
    fileName: RUNTIME_EXECUTABLE_NAME,
    sha256: sha256Hex(executable),
    bytes: executable.length,
    schemaFileName: RUNTIME_SCHEMA_NAME,
    schemaSha256: sha256Hex(schema),
    runtimeVersion: RELEASE_VERSION,
  };
  const catalog = {
    catalogVersion: '2',
    runtimeVersion: RELEASE_VERSION,
    requirements: [
      {
        requirementId: 'windowsml-ocr',
        artifacts: [
          {
            role: 'worker',
            fileName: `capture-engine-ocr-${RELEASE_VERSION}-windows-x64.zip`,
            url: `https://github.com/gx-capture/capture-workbench/releases/download/v${RELEASE_VERSION}/capture-engine-ocr-${RELEASE_VERSION}-windows-x64.zip`,
            bytes: worker.length,
            sha256: sha256Hex(worker),
          },
        ],
      },
      {
        // Published like the 0.8.0 speech worker: above one release asset, so
        // as ordered parts with no single `url`.
        requirementId: 'speech-recognition',
        artifacts: [
          {
            role: 'worker',
            fileName: SPEECH_ARCHIVE,
            bytes: SPEECH_PARTS.reduce((total, part) => total + part.length, 0),
            sha256: sha256Hex(Buffer.concat(SPEECH_PARTS)),
            parts: SPEECH_PARTS.map((part, index) => ({
              fileName: `${SPEECH_ARCHIVE}.00${index + 1}`,
              bytes: part.length,
              sha256: sha256Hex(part),
              url: `${RELEASE_DOWNLOAD}/${SPEECH_ARCHIVE}.00${index + 1}`,
            })),
          },
        ],
      },
    ],
  };
  const files = new Map<string, Buffer>([
    [RUNTIME_EXECUTABLE_NAME, executable],
    [RUNTIME_SCHEMA_NAME, schema],
    [RUNTIME_MANIFEST_NAME, Buffer.from(JSON.stringify(manifest))],
    [RUNTIME_CATALOG_NAME, Buffer.from(JSON.stringify(catalog))],
    [`capture-engine-ocr-${RELEASE_VERSION}-windows-x64.zip`, worker],
    ...SPEECH_PARTS.map((part, index): [string, Buffer] => [`${SPEECH_ARCHIVE}.00${index + 1}`, part]),
  ]);
  mutate(files);
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes);
  return { directory, runtimeSha256: sha256Hex(executable) };
}

test('runtime release directory is verified against an independent digest, the manifest and the catalog', async (t) => {
  const good = await releaseFixture();
  t.after(() => rm(good.directory, { recursive: true, force: true }));
  const release = verifyRuntimeReleaseDirectory(good.directory, good.runtimeSha256, RELEASE_VERSION);
  assert.equal(release.workers[0].requirementId, 'windowsml-ocr');
  assert.equal(release.executable.sha256, good.runtimeSha256);
  assert.throws(() => verifyRuntimeReleaseDirectory(good.directory, sha('other'), RELEASE_VERSION), /expected release digest/u);
  assert.throws(() => verifyRuntimeReleaseDirectory(good.directory, good.runtimeSha256, '99.0.0'), /manifest/u);

  const withSidecars = await releaseFixture((files) => {
    files.set(`${RUNTIME_EXECUTABLE_NAME}.sha256`, Buffer.from(`${sha('stale')}  ${RUNTIME_EXECUTABLE_NAME}\n`));
    files.set(`${RUNTIME_CATALOG_NAME}.sha256`, Buffer.from(`${sha('x')}  other.json\n`));
  });
  t.after(() => rm(withSidecars.directory, { recursive: true, force: true }));
  const ignoredSidecars = verifyRuntimeReleaseDirectory(withSidecars.directory, good.runtimeSha256, RELEASE_VERSION);
  assert.equal(ignoredSidecars.executable.sha256, good.runtimeSha256);
  assert.equal(ignoredSidecars.catalog.sha256, release.catalog.sha256);

  const cases: Array<[string, (files: Map<string, Buffer>) => void, RegExp]> = [
    [
      'substituted executable with its own sidecar',
      (files) => {
        files.set(RUNTIME_EXECUTABLE_NAME, Buffer.from('substituted'));
        files.set(`${RUNTIME_EXECUTABLE_NAME}.sha256`, Buffer.from(`${sha('substituted')}  ${RUNTIME_EXECUTABLE_NAME}\n`));
      },
      /expected release digest/u,
    ],
    ['schema substitution', (files) => files.set(RUNTIME_SCHEMA_NAME, Buffer.from('{}')), /manifest/u],
  ];
  for (const [label, mutate, expected] of cases) {
    const fixture = await releaseFixture(mutate);
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));
    assert.throws(() => verifyRuntimeReleaseDirectory(fixture.directory, good.runtimeSha256, RELEASE_VERSION), expected, label);
  }

  const wrongUrl = await releaseFixture((files) => {
    const catalog = JSON.parse(String(files.get(RUNTIME_CATALOG_NAME)));
    catalog.requirements[0].artifacts[0].url = 'https://example.invalid/worker.zip';
    files.set(RUNTIME_CATALOG_NAME, Buffer.from(JSON.stringify(catalog)));
  });
  t.after(() => rm(wrongUrl.directory, { recursive: true, force: true }));
  assert.throws(() => verifyRuntimeReleaseDirectory(wrongUrl.directory, good.runtimeSha256, RELEASE_VERSION), /worker artifact/u);
});

/** Edits the fixture catalog. Its digest is the catalog bytes themselves. */
function editCatalog(files: Map<string, Buffer>, edit: (speech: Record<string, unknown> & { parts: Array<Record<string, unknown>> }) => void) {
  const catalog = JSON.parse(String(files.get(RUNTIME_CATALOG_NAME)));
  edit(catalog.requirements[1].artifacts[0]);
  files.set(RUNTIME_CATALOG_NAME, Buffer.from(JSON.stringify(catalog)));
}

test('a worker published as parts is accepted and each part is verified like a single archive', async (t) => {
  const good = await releaseFixture();
  t.after(() => rm(good.directory, { recursive: true, force: true }));
  const release = verifyRuntimeReleaseDirectory(good.directory, good.runtimeSha256, RELEASE_VERSION);
  const [ocr, speech] = release.workers;
  assert.equal(ocr.url, `${RELEASE_DOWNLOAD}/capture-engine-ocr-${RELEASE_VERSION}-windows-x64.zip`);
  assert.deepEqual(ocr.parts, []);
  assert.equal(speech.requirementId, 'speech-recognition');
  assert.equal(speech.url, null);
  assert.deepEqual(speech.parts.map((part) => part.fileName), [`${SPEECH_ARCHIVE}.001`, `${SPEECH_ARCHIVE}.002`]);
  assert.deepEqual([...readVerifiedWorkerFiles(release, ocr).keys()], [ocr.fileName]);
  const parts = readVerifiedWorkerFiles(release, speech);
  assert.deepEqual([...parts.keys()], [`${SPEECH_ARCHIVE}.001`, `${SPEECH_ARCHIVE}.002`]);
  assert.ok(Buffer.concat([...parts.values()]).equals(Buffer.concat(SPEECH_PARTS)));

  // Part files on disk that are missing or differ from the catalog.
  const fileCases: Array<[string, (files: Map<string, Buffer>) => void, RegExp]> = [
    ['missing part file', (files) => files.delete(`${SPEECH_ARCHIVE}.002`), /\.002 must be a regular file/u],
    [
      'part with the catalog size but a wrong sha256',
      (files) => files.set(`${SPEECH_ARCHIVE}.001`, Buffer.from('speech worker part ONE')),
      /\.001 differs from the release engine catalog/u,
    ],
    ['part with a wrong size', (files) => files.set(`${SPEECH_ARCHIVE}.002`, Buffer.from('short')), /\.002 differs/u],
    [
      'parts that match their entries but not the whole archive digest',
      (files) => editCatalog(files, (speech) => (speech.sha256 = sha('another archive'))),
      /do not join/u,
    ],
  ];
  for (const [label, mutate, expected] of fileCases) {
    const fixture = await releaseFixture(mutate);
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));
    const verified = verifyRuntimeReleaseDirectory(fixture.directory, good.runtimeSha256, RELEASE_VERSION);
    assert.throws(() => readVerifiedWorkerFiles(verified, verified.workers[1]), expected, label);
  }

  // Catalog part entries that the runtime's catalog schema would reject.
  const catalogCases: Array<[string, Parameters<typeof editCatalog>[1], RegExp]> = [
    ['a missing part entry', (speech) => speech.parts.pop(), /parts are invalid/u],
    ['parts that do not add up to the archive', (speech) => (speech.bytes = Number(speech.bytes) + 1), /do not add up/u],
    ['a malformed part sha256', (speech) => (speech.parts[0].sha256 = 'NOT-A-DIGEST'), /part digest/u],
    ['a part named out of order', (speech) => (speech.parts[1].fileName = `${SPEECH_ARCHIVE}.003`), /part is invalid/u],
    ['a part outside the release', (speech) => (speech.parts[1].url = 'https://example.invalid/part'), /worker artifact is malformed/u],
    ['both url and parts', (speech) => (speech.url = `${RELEASE_DOWNLOAD}/${SPEECH_ARCHIVE}`), /worker artifact is invalid/u],
  ];
  for (const [label, edit, expected] of catalogCases) {
    const fixture = await releaseFixture((files) => editCatalog(files, edit));
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));
    assert.throws(() => verifyRuntimeReleaseDirectory(fixture.directory, good.runtimeSha256, RELEASE_VERSION), expected, label);
  }
});

test('application environment is allowlisted and only rehearsal adds the loopback worker mirror', () => {
  const inherited = {
    Path: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: '1',
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: 'C:\\models',
    CAPTURE_ACCEPTANCE_PDF_PAGE_SCOPE: 'page-1',
    APPDATA: 'C:\\elsewhere',
  };
  const options = { temporary: 'C:\\run\\temp', webViewData: 'C:\\run\\webview2', cdpPort: 9333 };
  const published = practicalChildEnvironment(inherited, options);
  assert.equal(published.PATH, 'C:\\Windows');
  assert.equal(published.SYSTEMROOT, 'C:\\Windows');
  assert.ok(Object.keys(published).every((name) => !name.startsWith('CAPTURE_') && name !== 'APPDATA'));
  assert.match(published.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, /--remote-debugging-port=9333/u);

  const rehearsal = practicalChildEnvironment(inherited, { ...options, workerMirrorOrigin: 'http://127.0.0.1:41234' });
  assert.equal(rehearsal.CAPTURE_SMOKE_WORKER_MIRROR_URL, 'http://127.0.0.1:41234');
  assert.equal(rehearsal.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT, undefined);
  assert.throws(() => practicalChildEnvironment(inherited, { ...options, workerMirrorOrigin: 'http://example.com:80' }), /loopback/u);
  assert.throws(() => practicalChildEnvironment(inherited, { ...options, cdpPort: 0 }), /CDP port/u);

  assert.throws(() => assertRuntimeReleaseMatchesMode('rehearsal', undefined), /require --runtime-release/u);
  assert.throws(() => assertRuntimeReleaseMatchesMode('published', 'C:\\release'), /forbidden/u);
});

test('owned process images match whole directory prefixes only', () => {
  const roots = ['C:\\run\\install', 'C:\\Users\\u\\AppData\\Roaming\\io.github.gx-capture.cw-practical-r20260924a'];
  const owned = ownedProcessImages(
    [
      { pid: 10, executablePath: 'C:\\run\\install\\capture-workbench-practical-r20260924a.exe' },
      { pid: 11, executablePath: 'c:\\RUN\\INSTALL\\binaries\\capture-runtime-x86_64-pc-windows-msvc.exe' },
      { pid: 12, executablePath: 'C:\\Users\\u\\AppData\\Roaming\\io.github.gx-capture.cw-practical-r20260924a\\runtime\\capture-engine-ocr.exe' },
      { pid: 13, executablePath: 'C:\\run\\install2\\evil.exe' },
      { pid: 14, executablePath: 'C:\\Users\\u\\AppData\\Roaming\\io.github.gx-capture.capture-workbench\\runtime\\capture-engine-ocr.exe' },
      { pid: 0, executablePath: 'C:\\run\\install\\x.exe' },
      { pid: 15, executablePath: 'relative\\x.exe' },
    ],
    roots,
  );
  assert.deepEqual(owned.map((record) => record.pid), [10, 11, 12]);
});

test('variant known-folder roots are direct identifier children of each known folder', () => {
  assert.deepEqual(
    practicalKnownFolderRoots({ roaming: 'C:\\Users\\u\\AppData\\Roaming', local: 'C:\\Users\\u\\AppData\\Local' }, variant),
    [
      'C:\\Users\\u\\AppData\\Roaming\\io.github.gx-capture.cw-practical-r20260924a',
      'C:\\Users\\u\\AppData\\Local\\io.github.gx-capture.cw-practical-r20260924a',
    ],
  );
  assert.throws(() => practicalKnownFolderRoots({ roaming: 'relative', local: 'C:\\x' }, variant), /absolute/u);
});

function provenance(overrides: Record<string, unknown> = {}) {
  const file = { fileName: 'f', bytes: 1, sha256: sha('f') };
  return {
    schemaVersion: '1',
    evidenceKind: 'capture-practical-installer',
    mode: 'published',
    variant,
    sourceCommit: 'a'.repeat(40),
    sourceTreeClean: true,
    releaseVersion: RELEASE_VERSION,
    runtime: {
      runtimeVersion: RELEASE_VERSION,
      executable: file,
      manifest: file,
      schema: file,
      catalog: file,
      workers: [{ requirementId: 'windowsml-ocr', ...file, url: 'u' }],
    },
    overlaySha256: sha('overlay'),
    installer: file,
    ...overrides,
  };
}

test('installer provenance binds a consistent variant and a clean tree for published runs', () => {
  assert.doesNotThrow(() => assertPracticalProvenance(provenance()));
  assert.doesNotThrow(() => assertPracticalProvenance(provenance({ mode: 'rehearsal', sourceTreeClean: false })));
  assert.throws(() => assertPracticalProvenance(provenance({ sourceTreeClean: false })), /clean source tree/u);
  assert.throws(
    () => assertPracticalProvenance(provenance({ variant: { ...variant, productName: 'Capture Workbench' } })),
    /inconsistent/u,
  );
  assert.throws(() => assertPracticalProvenance(provenance({ mode: 'local' })), /mode/u);
});

function evidence(overrides: Partial<PracticalOcrEvidence> = {}): PracticalOcrEvidence {
  return {
    schemaVersion: '1',
    evidenceKind: 'capture-practical-installed-ocr',
    mode: 'published',
    releaseGateSatisfied: false,
    usabilityReview: 'pending-private-human-review',
    accuracy: 'CER not evaluated',
    runId: variant.runId,
    sourceCommit: 'a'.repeat(40),
    releaseVersion: RELEASE_VERSION,
    installerSha256: sha('installer'),
    runtimeExecutableSha256: sha('runtime'),
    workerSource: 'github-release',
    workerArchiveSha256: sha('archive'),
    fixture: { kind: 'image', sha256: sha('jpeg'), bytes: 10 },
    importedSourceSha256: sha('jpeg'),
    runtime: { contractSetSha256: sha('contract'), workerExecutableSha256: sha('worker'), computeMode: 'gpu-dml' },
    ocr: { engine: 'windowsml-ocr', model: 'pp-ocrv6-medium-windowsml', device: 'windowsml-dml', segmentCount: 3, characterCount: 40 },
    observedProcessImages: { runtimeExecutableSha256: [sha('runtime')], workerExecutableSha256: [sha('worker')] },
    durationsMs: { install: 1, runtimeReady: 1, ocr: 1 },
    cleanup: {
      normalWindowClose: true,
      forcedTerminationCount: 0,
      ownedProcessesStopped: true,
      cdpPortReleased: true,
      uninstallerCompleted: true,
      installDirectoryRemoved: true,
      uninstallKeyRemoved: true,
      registryResidueRemoved: true,
      variantDataRemoved: true,
      runDirectoryRemoved: true,
      ordinaryInstallationPreserved: true,
    },
    ...overrides,
  };
}

test('practical evidence is private, mode-consistent and requires proven cleanup', () => {
  assert.doesNotThrow(() => assertPracticalEvidence(evidence()));
  const rejected: Array<[Partial<PracticalOcrEvidence>, RegExp]> = [
    [{ workerSource: 'loopback-mirror-of-verified-release-directory' }, /download the worker/u],
    [{ mode: 'rehearsal' }, /cannot claim/u],
    [{ importedSourceSha256: sha('other') }, /Imported source/u],
    [{ ocr: { ...evidence().ocr, segmentCount: 0 } }, /no visible text/u],
    [{ observedProcessImages: { runtimeExecutableSha256: [sha('substituted')], workerExecutableSha256: [] } }, /runtime image/u],
    [{ observedProcessImages: { runtimeExecutableSha256: [], workerExecutableSha256: [sha('other')] } }, /worker image/u],
    [{ cleanup: { ...evidence().cleanup, forcedTerminationCount: 1 } }, /cleanup/u],
    [{ cleanup: { ...evidence().cleanup, ordinaryInstallationPreserved: false } }, /cleanup/u],
    [{ runtime: { ...evidence().runtime, contractSetSha256: 'C:\\Users\\u\\secret.txt' } }, /local paths/u],
  ];
  for (const [overrides, expected] of rejected) {
    assert.throws(() => assertPracticalEvidence(evidence(overrides)), expected);
  }
});

test('build and run CLIs require explicit complete inputs', () => {
  const build = parseBuildArguments([
    '--mode', 'rehearsal', '--runtime-release', 'dist', '--runtime-sha256', sha('x'), '--run-id', variant.runId,
  ]);
  assert.equal(build.mode, 'rehearsal');
  assert.throws(() => parseBuildArguments(['--mode', 'rehearsal']), /Missing required/u);
  assert.throws(() => parseBuildArguments(['--mode', 'local', '--runtime-release', 'd', '--runtime-sha256', sha('x'), '--run-id', variant.runId]), /rehearsal or published/u);
  assert.throws(() => parseBuildArguments(['--mode', 'published', '--mode', 'published']), /Use --mode/u);

  const run = parseRunArguments(['--provenance', 'p.json', '--input', 'a.jpg', '--input-sha256', sha('a')]);
  assert.equal(run.runtimeRelease, undefined);
  assert.throws(() => parseRunArguments(['--provenance', 'p.json', '--input', 'a.jpg']), /Missing required --input-sha256/u);
  assert.throws(() => parseRunArguments(['--provenance', 'p.json', '--input', 'a.jpg', '--input-sha256', 'ABC']), /SHA-256/u);
});

test('practical CLI modules load under Node type stripping', async () => {
  await import('./build-practical-installer.ts');
  const run = await import('./practical-installed-ocr.ts');
  assert.equal(typeof run.runPracticalInstalledOcr, 'function');
});
