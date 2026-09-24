import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { resolveNode24Corepack } from './node24-corepack.ts';

const root = join(import.meta.dirname, '..');
const expectedVersion = '12.0.0';
const expectedPackageManager = `pnpm@${expectedVersion}`;
const bootstrapWorkflows = [
  '.github/workflows/ci.yml',
  '.github/workflows/package-candidate.yml',
  '.github/workflows/runtime-candidate.yml',
  '.github/workflows/release-candidate.yml',
] as const;
const generatedConsumerSources = [
  'tools/clean-angular-consumer-smoke.ts',
  'tools/runtime-web-component-e2e.ts',
] as const;

async function readRootFile(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8');
}

test('workspace package-manager sources pin exact pnpm 12.0.0', async () => {
  const manifest = JSON.parse(await readRootFile('package.json')) as {
    packageManager?: unknown;
    engines?: { pnpm?: unknown };
  };
  assert.equal(manifest.packageManager, expectedPackageManager);
  assert.equal(manifest.engines?.pnpm, expectedVersion);

  const workspace = await readRootFile('pnpm-workspace.yaml');
  assert.match(
    workspace,
    /# pnpm 12 requires an explicit decision for dependency lifecycle scripts\./u,
  );
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
    const exactVersionCount =
      workflow.match(/^\s+version:\s+12\.0\.0\s*$/gmu)?.length ?? 0;
    assert.ok(setupCount > 0, `${workflowPath} must install pnpm`);
    assert.equal(
      exactVersionCount,
      setupCount,
      `${workflowPath} must pin every pnpm bootstrap to ${expectedVersion}`,
    );
    assert.doesNotMatch(
      workflow,
      /version:\s*(?:latest|next|(?:[<>=~^*]|\d+\.\d+\.\d*-))/iu,
      `${workflowPath} must not use a floating or pre-12 pnpm version`,
    );
  }

  for (const sourcePath of generatedConsumerSources) {
    const source = await readRootFile(sourcePath);
    assert.equal(
      source.match(new RegExp(`pnpm@${expectedVersion}`, 'gu'))?.length,
      1,
      `${sourcePath} must generate an exact pnpm packageManager pin`,
    );
    assert.match(
      source,
      new RegExp(`pnpm: '${expectedVersion}'`, 'u'),
      `${sourcePath} must enforce the exact pnpm engine`,
    );
  }

  for (const documentationPath of [
    'README.md',
    '.agents/DECISIONS/web-component-and-runtime-baselines.md',
    '.agents/SPECS/web-component-and-runtime-baselines.md',
  ]) {
    const documentation = await readRootFile(documentationPath);
    assert.doesNotMatch(
      documentation,
      /pnpm(?:@11|\s+11|\s*`>=11|:\s*['"]>=11)/iu,
      `${documentationPath} must not describe a legacy pnpm release as supported`,
    );
  }
});

test('workspace pnpm command resolves to exact pnpm 12.0.0', () => {
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
