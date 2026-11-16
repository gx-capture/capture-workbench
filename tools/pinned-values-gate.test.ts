import './test-temp-root.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { collectPinnedValues, runPinnedValuesGate } from './pinned-values-gate.ts';

const version = [8, 6, 4].join('.');
const nextVersion = [8, 6, 5].join('.');
const hash = 'a'.repeat(64);
const documentHash = 'b'.repeat(64);
const rawHash = 'c'.repeat(64);
const asset = 'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256';
const generated = 'packages/capture-runtime-client/src/private/generated-contracts.ts';
const bundle = 'packages/capture-runtime/src/capture_runtime/assets/contract-set.json';
const baseline = 'tools/quality/pinned-values-baseline.json';

function put(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'pinned-values-'));
  put(root, 'release/version.json', JSON.stringify({ releaseVersion: version }));
  put(root, asset, `${hash}\n`);
  put(root, generated, `export const CAPTURE_DOCUMENT_SCHEMA_SHA256 = "${documentHash}";`);
  put(root, bundle, JSON.stringify({ schemas: [{ schemaSha256: rawHash }] }));
  put(root, baseline, '[]\n');
  return root;
}

function capture(run: () => number): { code: number; stderr: string } {
  const error = console.error;
  const log = console.log;
  let stderr = '';
  console.error = (message: string) => { stderr += `${message}\n`; };
  console.log = () => undefined;
  try { return { code: run(), stderr }; }
  finally { console.error = error; console.log = log; }
}

test('reports exact current literals, with line numbers and stable per-kind ordinals', () => {
  const root = workspace();
  const file = 'tools/example.test.ts';
  put(root, file, [
    `// '${version}'`,
    `const old = '0.3.8'; const embedded = 'prefix-${version}';`,
    `const current = '${version}';`,
    `const second = "${version}";`,
    `const copied = '${hash}';`,
    `const document = '${documentHash}'; const raw = '${rawHash}';`,
  ].join('\n'));
  const findings = collectPinnedValues(root, [file, file, asset, generated, bundle, 'release/version.json']);
  assert.deepEqual(findings.map(({ key, line }) => [key, line]), [
    [`release-version|${file}|1`, 3], [`release-version|${file}|2`, 4],
    [`contract-set-sha256|${file}|1`, 5],
    [`document-schema-sha256|${file}|1`, 6], [`contract-schema-sha256|${file}|1`, 6],
  ]);
  const failure = capture(() => runPinnedValuesGate(root, [], [file]));
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /example\.test\.ts:3/u);
  assert.match(failure.stderr, /import RELEASE_VERSION \/ the generated constant, or use an obviously synthetic value/u);
});

test('reads version and digest sources anew on each run', () => {
  const root = workspace();
  const file = 'tools/source.spec.ts';
  put(root, file, `'${version}'; '${nextVersion}'; '${hash}'; '${'d'.repeat(64)}';`);
  assert.deepEqual(collectPinnedValues(root, [file]).map(({ line, kind }) => [line, kind]), [
    [1, 'release-version'], [1, 'contract-set-sha256'],
  ]);
  put(root, 'release/version.json', JSON.stringify({ releaseVersion: nextVersion }));
  put(root, asset, 'd'.repeat(64));
  put(root, file, `'${version}'; '${hash}';`);
  assert.deepEqual(collectPinnedValues(root, [file]), []);
  put(root, file, `'${nextVersion}'; '${'d'.repeat(64)}';`);
  assert.equal(collectPinnedValues(root, [file]).length, 2);
});

test('update suppresses findings; only CI fails vanished entries; update shrinks them', () => {
  const root = workspace();
  const file = 'tools/a.test.ts';
  put(root, file, `'${version}'`);
  assert.equal(capture(() => runPinnedValuesGate(root, [], [file])).code, 1);
  assert.equal(capture(() => runPinnedValuesGate(root, ['--update'], [file])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(root, baseline), 'utf8')), [`release-version|${file}|1`]);
  assert.equal(capture(() => runPinnedValuesGate(root, ['--ci'], [file])).code, 0);
  put(root, file, "'0.3.8'");
  assert.equal(capture(() => runPinnedValuesGate(root, [], [file])).code, 0);
  const stale = capture(() => runPinnedValuesGate(root, ['--ci'], [file]));
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /node tools\/pinned-values-gate\.ts --update/u);
  capture(() => runPinnedValuesGate(root, ['--update'], [file]));
  assert.deepEqual(JSON.parse(readFileSync(join(root, baseline), 'utf8')), []);
  assert.equal(capture(() => runPinnedValuesGate(root, ['--ci'], [file])).code, 0);
});

test('covers test, double, fixture and Rust test boundaries while ignoring production and comments', () => {
  const root = workspace();
  const files = [
    'tools/a.e2e.ts', 'packages/a/tests/a.py', 'packages/a/tests/a.ts',
    'apps/capture-workbench-desktop/scripts/fixtures/double.ts',
    'apps/capture-workbench-desktop/scripts/fixtures/double.rs',
    'apps/capture-workbench-e2e/src/double.ts', 'test-fixtures/a.json',
    'packages/a/tests/fixtures/a.json',
  ];
  for (const file of files) put(root, file, `"${version}"`);
  const rust = 'packages/capture-sidecar-launcher/src/process.rs';
  const appRust = 'apps/desktop/src-tauri/src/main.rs';
  for (const file of [rust, appRust]) {
    put(root, file, `const PROD: &str = "${version}";\n#[cfg(test)]\nconst TEST: &'static str = "${version}";`);
  }
  put(root, 'tools/production.ts', `"${version}"`);
  put(root, 'packages/a/tests/comments.py', `# "${version}"\nx = "0.3.8"`);
  put(root, 'tools/comments.test.ts', `/* "${version}" */\n// '${hash}'`);
  const fixtureManifest = 'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.toml';
  put(root, fixtureManifest, `version = "${version}"`);
  const findings = collectPinnedValues(root, [...files, rust, appRust, 'tools/production.ts',
    'packages/a/tests/comments.py', 'tools/comments.test.ts', fixtureManifest]);
  assert.equal(findings.length, files.length + 2);
  assert.equal(findings.find(({ file }) => file === rust)?.line, 3);
});
