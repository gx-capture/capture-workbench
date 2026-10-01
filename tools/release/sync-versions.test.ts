import '../test-temp-root.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { RELEASE_VERSION, workspaceRoot } from './release-intent.ts';
import { RELEASE_VERSION_OWNERS, readOwner } from './version-owners.ts';
import {
  applyReleaseVersionPlan,
  planReleaseVersion,
  synchronizeReleaseVersion,
} from './sync-versions.ts';
import { releaseArguments } from './run-with-release-version.ts';
import {
  NATIVE_RELEASE_LOCKS,
  verifyNativeLockVersions,
} from './native-lock-versions.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function fixture(t: { after: (callback: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'capture-version-owners-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const owner of RELEASE_VERSION_OWNERS) {
    const path = join(root, owner.path);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(workspaceRoot, owner.path), path);
  }
  return root;
}

function snapshot(root: string): string[] {
  return RELEASE_VERSION_OWNERS.map((owner) =>
    readFileSync(join(root, owner.path), 'utf8'),
  );
}

test('alternate release updates only declared owners and a second update is a no-op', (t) => {
  const root = fixture(t);
  const packagePath = join(
    root,
    'packages/capture-runtime-client/package.json',
  );
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.dependencies['unrelated-same-version'] = RELEASE_VERSION;
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
  const evidencePath = join(root, 'historical-evidence.json');
  const evidence = JSON.stringify({
    releaseVersion: RELEASE_VERSION,
    sha256: 'f'.repeat(64),
  });
  writeFileSync(evidencePath, evidence);
  const before = snapshot(root);
  const plan = planReleaseVersion(root, '7.8.9');
  assert.deepEqual(snapshot(root), before);
  assert.equal(plan.changes.length, RELEASE_VERSION_OWNERS.length);
  assert.ok(plan.followUp.some((step) => step.includes('approval')));
  applyReleaseVersionPlan(root, plan);
  for (const owner of RELEASE_VERSION_OWNERS)
    assert.equal(readOwner(root, owner).version, '7.8.9');
  assert.equal(
    JSON.parse(readFileSync(packagePath, 'utf8')).dependencies[
      'unrelated-same-version'
    ],
    RELEASE_VERSION,
  );
  assert.equal(readFileSync(evidencePath, 'utf8'), evidence);
  assert.deepEqual(synchronizeReleaseVersion(root), []);
  assert.deepEqual(planReleaseVersion(root).changes, []);
});

test('invalid versions and duplicate declarations reject before writing', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  for (const version of ['01.2.3', '1.2', '../1.2.3', '1.2.3-01', '1.2.3\n']) {
    assert.throws(
      () => planReleaseVersion(root, version),
      /Invalid release version/u,
    );
    assert.deepEqual(snapshot(root), before);
  }
  const finalOwner = RELEASE_VERSION_OWNERS[RELEASE_VERSION_OWNERS.length - 1];
  const path = join(root, finalOwner.path);
  const content = readFileSync(path, 'utf8');
  writeFileSync(
    path,
    content.replace(
      /"runtimeVersion"\s*:/u,
      `"runtimeVersion": "${RELEASE_VERSION}", "runtimeVersion":`,
    ),
  );
  const broken = snapshot(root);
  assert.throws(
    () => synchronizeReleaseVersion(root, { version: '7.8.9' }),
    /exactly one owner|Duplicate/u,
  );
  assert.deepEqual(snapshot(root), broken);
});

test('stale plans and caller-injected file changes cannot write', (t) => {
  const root = fixture(t);
  const plan = planReleaseVersion(root, '7.8.9');
  const path = join(root, 'packages/capture-runtime-client/package.json');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      'Framework-neutral',
      'Externally edited',
    ),
  );
  const edited = snapshot(root);
  assert.throws(
    () => applyReleaseVersionPlan(root, plan),
    /changed since planning/u,
  );
  assert.deepEqual(snapshot(root), edited);
  const fresh = planReleaseVersion(root, '7.8.9');
  assert.throws(
    () =>
      applyReleaseVersionPlan(root, {
        ...fresh,
        changes: [
          ...fresh.changes,
          { path: '../outside', before: '', after: 'invalid' },
        ],
      }),
    /changed since planning/u,
  );
  assert.deepEqual(snapshot(root), edited);
});

test('the helper previews pending owners without mutation when apply is omitted', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const plannedPaths = planReleaseVersion(root, '7.8.9').changes.map(
    (change) => change.path,
  );
  assert.deepEqual(
    synchronizeReleaseVersion(root, { version: '7.8.9' }),
    plannedPaths,
  );
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(
    synchronizeReleaseVersion(root, { apply: false, version: '7.8.9' }),
    plannedPaths,
  );
  assert.deepEqual(snapshot(root), before);

  const owner = RELEASE_VERSION_OWNERS.find(
    (item) => item.path === 'packages/capture-runtime-client/package.json',
  );
  assert.ok(owner);
  const { content, valueStart, valueEnd } = readOwner(root, owner);
  writeFileSync(
    join(root, owner.path),
    `${content.slice(0, valueStart)}7.8.9${content.slice(valueEnd)}`,
  );
  const drifted = snapshot(root);
  assert.deepEqual(synchronizeReleaseVersion(root), [owner.path]);
  assert.deepEqual(snapshot(root), drifted);
  const result = spawnSync(
    process.execPath,
    [join(workspaceRoot, 'tools/release/sync-versions.ts'), '--root', root],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'plan');
  assert.deepEqual(report.changedFiles, [owner.path]);
  assert.deepEqual(snapshot(root), drifted);
});

test('check and CLI previews, including the default mode, never mutate owners', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.throws(
    () => synchronizeReleaseVersion(root, { check: true, version: '7.8.9' }),
    /not synchronized/u,
  );
  assert.deepEqual(snapshot(root), before);
  for (const flags of [[], ['--plan'], ['--dry-run']]) {
    const result = spawnSync(
      process.execPath,
      [
        join(workspaceRoot, 'tools/release/sync-versions.ts'),
        '--root',
        root,
        '--version',
        '7.8.9',
        ...flags,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'plan');
    assert.equal(report.status, 'planned');
    assert.equal(report.changedFiles.length, RELEASE_VERSION_OWNERS.length);
    assert.deepEqual(snapshot(root), before);
  }
});

test('the helper requires explicit apply and rejects check combined with apply', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.throws(
    () =>
      synchronizeReleaseVersion(root, {
        check: true,
        apply: true,
        version: '7.8.9',
      }),
    /Select either check or apply/u,
  );
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(
    synchronizeReleaseVersion(root, { apply: true, version: '7.8.9' }),
    RELEASE_VERSION_OWNERS.map((owner) => owner.path),
  );
  for (const owner of RELEASE_VERSION_OWNERS)
    assert.equal(readOwner(root, owner).version, '7.8.9');
  const after = snapshot(root);
  assert.deepEqual(
    synchronizeReleaseVersion(root, { apply: true, version: '7.8.9' }),
    [],
  );
  assert.deepEqual(snapshot(root), after);
});

test('CLI apply updates owners only with an unambiguous apply flag', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  for (const flags of [
    ['--apply', '--plan'],
    ['--check', '--apply'],
    ['--dry-run', '--apply'],
  ]) {
    const rejected = spawnSync(
      process.execPath,
      [
        join(workspaceRoot, 'tools/release/sync-versions.ts'),
        '--root',
        root,
        '--version',
        '7.8.9',
        ...flags,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejected.status, 1, String(rejected.error));
    assert.match(rejected.stderr, /Select one of/u);
    assert.deepEqual(snapshot(root), before);
  }
  const applied = spawnSync(
    process.execPath,
    [
      join(workspaceRoot, 'tools/release/sync-versions.ts'),
      '--root',
      root,
      '--version',
      '7.8.9',
      '--apply',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(applied.status, 0, applied.stderr || String(applied.error));
  const report = JSON.parse(applied.stdout);
  assert.equal(report.mode, 'apply');
  assert.equal(report.status, 'version-sources-prepared');
  assert.deepEqual(
    report.changedFiles,
    RELEASE_VERSION_OWNERS.map((owner) => owner.path),
  );
  for (const owner of RELEASE_VERSION_OWNERS)
    assert.equal(readOwner(root, owner).version, '7.8.9');
});

test('native command arguments reference the requested release without shell interpolation', () => {
  assert.deepEqual(
    releaseArguments(
      ['--archive', 'dir with spaces/capture-{releaseVersion}.zip', '$literal'],
      '7.8.9',
    ),
    ['--archive', 'dir with spaces/capture-7.8.9.zip', '$literal'],
  );
});

test('TOML owners require the declared section and preserve foreign versions', (t) => {
  const root = fixture(t);
  for (const owner of RELEASE_VERSION_OWNERS.filter(
    (item) => item.tomlSection,
  )) {
    const path = join(root, owner.path);
    const original = readFileSync(path, 'utf8');
    const foreign = `\n[tool.unrelated]\nversion = "${RELEASE_VERSION}"\n`;
    writeFileSync(path, original + foreign);
    const plan = planReleaseVersion(root, '7.8.9');
    assert.ok(
      plan.changes
        .find((change) => change.path === owner.path)
        ?.after.endsWith(foreign),
    );
    const parsed = readOwner(root, owner);
    writeFileSync(
      path,
      parsed.content
        .slice(0, parsed.valueStart)
        .replace(/version[\t ]*=[\t ]*"$/u, 'missing = "') +
        parsed.content.slice(parsed.valueStart),
    );
    const broken = snapshot(root);
    assert.throws(
      () => synchronizeReleaseVersion(root, { version: '7.8.9' }),
      /exactly one owner/u,
    );
    assert.deepEqual(snapshot(root), broken);
    writeFileSync(path, original);
  }
});

test('apply restores every attempted file after a partial write failure', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const plan = planReleaseVersion(root, '7.8.9');
  const actualWrite = fs.writeFileSync;
  let writes = 0;
  t.mock.method(
    fs,
    'writeFileSync',
    (...args: Parameters<typeof fs.writeFileSync>) => {
      if (++writes === 2) {
        actualWrite(args[0], 'partial write');
        throw new Error('simulated write failure');
      }
      return actualWrite(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => applyReleaseVersionPlan(root, plan),
      /simulated write failure/u,
    );
    assert.deepEqual(snapshot(root), before);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('Maven updates only the direct project version regardless of indentation', (t) => {
  const root = fixture(t);
  const owner = RELEASE_VERSION_OWNERS.find((item) => item.xmlProjectVersion);
  assert.ok(owner);
  const path = join(root, owner.path);
  const foreign = `<dependencies><dependency><version>${RELEASE_VERSION}</version></dependency></dependencies>`;
  const original = `<project><version>${RELEASE_VERSION}</version>${foreign}</project>`;
  writeFileSync(path, original);
  const plan = planReleaseVersion(root, '7.8.9');
  assert.equal(
    plan.changes.find((change) => change.path === owner.path)?.after,
    `<project><version>7.8.9</version>${foreign}</project>`,
  );
  for (const invalid of [
    `<project>${foreign}</project>`,
    `<project><version>${RELEASE_VERSION}</version><version>${RELEASE_VERSION}</version>${foreign}</project>`,
  ]) {
    writeFileSync(path, invalid);
    const before = snapshot(root);
    assert.throws(
      () => synchronizeReleaseVersion(root, { version: '7.8.9' }),
      /exactly one direct project\/version/u,
    );
    assert.deepEqual(snapshot(root), before);
  }
});

test('native lock validation rejects stale local identities without touching external dependencies', (t) => {
  const root = fixture(t);
  for (const [path] of NATIVE_RELEASE_LOCKS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(workspaceRoot, path), join(root, path));
  }
  verifyNativeLockVersions(root, RELEASE_VERSION);
  for (const [path, names] of NATIVE_RELEASE_LOCKS) {
    const fullPath = join(root, path);
    const original = readFileSync(fullPath, 'utf8');
    writeFileSync(
      fullPath,
      original.replace(
        `name = "${names[0]}"\nversion = "${RELEASE_VERSION}"`,
        `name = "${names[0]}"\nversion = "99.0.0"`,
      ),
    );
    assert.throws(
      () => verifyNativeLockVersions(root, RELEASE_VERSION),
      /local release/u,
    );
    writeFileSync(fullPath, original);
  }
  assert.ok(
    planReleaseVersion(root).followUp.length > 0,
    'missing derived artifacts stay pending even with synchronized owners',
  );
});
