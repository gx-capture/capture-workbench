import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { resolveNode24Corepack } from './node24-corepack.ts';
import {
  packageManagerPolicy,
  readPackageManagerPolicy,
} from './package-manager.ts';

const root = join(import.meta.dirname, '..');
const expectedPolicy = readPackageManagerPolicy(root);
const expectedVersion = expectedPolicy.engines.pnpm;
const expectedPackageManager = expectedPolicy.packageManager;
const bootstrapWorkflows = [
  '.github/workflows/ci.yml',
  '.github/workflows/package-candidate.yml',
  '.github/workflows/runtime-candidate.yml',
  '.github/workflows/release-candidate.yml',
] as const;

async function readRootFile(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8');
}

test('workspace and CI use the exact pnpm version owned by package.json', async () => {
  const manifest = JSON.parse(await readRootFile('package.json')) as {
    packageManager?: unknown;
    engines?: { pnpm?: unknown };
  };
  assert.equal(manifest.packageManager, expectedPackageManager);
  assert.equal(manifest.engines?.pnpm, expectedVersion);

  const workspace = await readRootFile('pnpm-workspace.yaml');
  assert.match(
    workspace,
    /^pmOnFail:\s+ignore\s*$/mu,
    'pnpm 12 must not emit its package-manager env document into the workspace lockfile',
  );

  const lockfile = await readRootFile('pnpm-lock.yaml');
  assert.equal(
    lockfile.match(/^lockfileVersion:/gmu)?.length,
    1,
    'pnpm-lock.yaml must contain one project lockfile document so Nx and other consumers can parse it',
  );
  assert.doesNotMatch(
    lockfile,
    /^\s*packageManagerDependencies:/mu,
    'the package-manager env document is intentionally disabled; package.json and CI own the exact pnpm pin',
  );

  for (const workflowPath of bootstrapWorkflows) {
    const workflow = await readRootFile(workflowPath);
    const setupCount = workflow.match(/pnpm\/action-setup@/gu)?.length ?? 0;
    assert.ok(setupCount > 0, `${workflowPath} must install pnpm`);
    const setupSteps = workflow
      .split(/(?=^\x20{6}- )/mu)
      .filter((step) => /uses: pnpm\/action-setup@/u.test(step));
    assert.equal(setupSteps.length, setupCount);
    for (const step of setupSteps) {
      assert.doesNotMatch(
        step,
        /^\s+version:/mu,
        `${workflowPath} must read packageManager instead of duplicating its version`,
      );
    }
  }
});

test('isolated consumers inherit tooling fields and reject mismatched or floating pins', () => {
  const alternative = {
    packageManager: 'pnpm@12.99.1',
    engines: { node: '>=24.0.0', pnpm: '12.99.1' },
    dependencies: { unrelated: '12.8.2' },
  };
  assert.deepEqual(packageManagerPolicy(alternative), {
    packageManager: alternative.packageManager,
    engines: alternative.engines,
  });
  for (const broken of [
    { ...alternative, packageManager: 'pnpm@latest' },
    { ...alternative, packageManager: 'pnpm@12.99.01' },
    { ...alternative, packageManager: 'pnpm@11.0.0' },
    { ...alternative, engines: { node: '>=24.0.0', pnpm: '12.0.0' } },
  ])
    assert.throws(() => packageManagerPolicy(broken), /exact pnpm 12/u);
});

test('workspace pnpm command resolves to its exact declared version', () => {
  const corepackCli = resolveNode24Corepack();
  assert.ok(corepackCli, 'Node 24 Corepack must be available');
  const actualVersion = execFileSync(
    process.execPath,
    [corepackCli, 'pnpm', '--version'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  ).trim();
  assert.equal(actualVersion, expectedVersion);
});
