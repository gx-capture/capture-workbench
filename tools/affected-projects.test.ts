import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');

// The path of Nx's CLI script has moved between releases; its package.json names it.
function nxBinPath(): string {
  const manifestPath = createRequire(import.meta.url).resolve('nx/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin: { nx: string };
  };
  return join(dirname(manifestPath), manifest.bin.nx);
}

const nxBin = nxBinPath();

// Nx 24 has no affected.legacy, so `nx show projects --affected` uses the
// project graph plus `{workspaceRoot}` inputs on targets. `--files` supplies
// the changed set without git or a network.
function affectedProjects(file: string): string[] {
  const stdout = execFileSync(
    process.execPath,
    [nxBin, 'show', 'projects', '--affected', `--files=${file}`, '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NX_DAEMON: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  assert.ok(start >= 0 && end > start, stdout);
  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
  assert.ok(Array.isArray(parsed), stdout);
  return parsed.map(String);
}

function projectsWithTarget(target: string, file: string): string[] {
  const stdout = execFileSync(
    process.execPath,
    [nxBin, 'show', 'projects', '--affected', `--files=${file}`, `--with-target=${target}`, '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NX_DAEMON: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  assert.ok(start >= 0 && end > start, stdout);
  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
  assert.ok(Array.isArray(parsed), stdout);
  return parsed.map(String);
}

/** The value of `--name=<list>` or `-t <list>` in one command's arguments, sorted. */
function listOption(argumentsText: string, option: RegExp): string[] {
  const match = option.exec(argumentsText);
  return match ? match[1].split(',').sort() : [];
}

/**
 * Every `nx affected` command in a command line or script, as its targets and
 * the projects it excludes; base, head and parallelism are left out because
 * the pull request and the local script set them differently on purpose.
 */
function affectedSelections(commands: string): string[] {
  return [...commands.matchAll(/nx affected ([^\r\n&]*)/gu)]
    .map((match) => {
      const targets = listOption(match[1], /-t "?([\w,-]+)"?/u);
      const excluded = listOption(match[1], /--exclude="?([\w,-]+)"?/u);
      return `targets=${targets.join(',')} exclude=${excluded.join(',')}`;
    })
    .sort();
}

function assertIncludes(projects: readonly string[], required: readonly string[]): void {
  for (const name of required) {
    assert.ok(projects.includes(name), `${name} missing from ${projects.join(', ')}`);
  }
}

test('a runtime contract fixture affects the clients and the launcher', () => {
  const projects = affectedProjects(
    'packages/capture-runtime/tests/fixtures/speaker-wire-samples.json',
  );
  assertIncludes(projects, [
    'capture-runtime-client',
    'capture-runtime-client-python',
    'capture-workbench-ui',
    'capture-sidecar-launcher',
  ]);
});

test('a workflow file affects capture-tools', () => {
  const projects = affectedProjects('.github/workflows/wiki-overview.yml');
  assertIncludes(projects, ['capture-tools']);
});

test('a Workbench UI component does not affect the runtime, the Python client, or the launcher', () => {
  const projects = affectedProjects(
    'apps/capture-workbench/src/app/history/history-list-page.ts',
  );
  for (const name of [
    'capture-runtime',
    'capture-runtime-client-python',
    'capture-sidecar-launcher',
  ]) {
    assert.equal(projects.includes(name), false, name);
  }
});

test('the runtime lockfile affects capture-runtime', () => {
  const projects = affectedProjects('packages/capture-runtime/uv.lock');
  assertIncludes(projects, ['capture-runtime']);
});

test('a pull request and verify:affected select the same targets with the same exclusions, the Workbench production bundle check among them', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const checksJob = workflow.slice(workflow.indexOf('\n  checks:\n'), workflow.indexOf('\n  packages:\n'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const pullRequest = affectedSelections(checksJob);
  const local = affectedSelections(manifest.scripts['verify:affected'] ?? '');
  assert.ok(pullRequest.length > 0, 'the checks job runs no nx affected command');
  assert.deepEqual(local, pullRequest);
  assert.ok(
    pullRequest.some((selection) => /targets=\S*\bproduction-bundle-check\b/u.test(selection)),
    pullRequest.join('\n'),
  );
});

test('a change to the Workbench or to the UI library it bundles selects its production bundle check', () => {
  for (const file of [
    'apps/capture-workbench/src/app/history/history-list-page.ts',
    'packages/capture-workbench-ui/src/index.ts',
  ]) {
    assert.deepEqual(projectsWithTarget('production-bundle-check', file), ['capture-workbench'], file);
  }
});

test('a change to the production bundle verifier alone selects the check', () => {
  assert.deepEqual(
    projectsWithTarget('production-bundle-check', 'tools/verify-capture-workbench-production-bundle.ts'),
    ['capture-workbench'],
  );
});

test('a change that does not affect the Workbench does not select its production bundle check', () => {
  for (const file of [
    'packages/capture-runtime/src/capture_runtime/release.py',
    'tools/local-release-consumer-smoke.ts',
  ]) {
    assert.deepEqual(projectsWithTarget('production-bundle-check', file), [], file);
  }
});
