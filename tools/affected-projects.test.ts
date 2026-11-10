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
    'capture-angular',
    'capture-sidecar-launcher',
  ]);
});

test('a workflow file affects capture-tools', () => {
  const projects = affectedProjects('.github/workflows/wiki-overview.yml');
  assertIncludes(projects, ['capture-tools']);
});

test('a Workbench UI component does not affect the runtime, the Python client, or the launcher', () => {
  const projects = affectedProjects(
    'apps/capture-workbench/src/app/history/history-page.ts',
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
