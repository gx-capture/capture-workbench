import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAcceptancePlan, validateChildManifest } from './three-project-acceptance.ts';

test('three-project acceptance plan is fixed and sequential', () => {
  const plan = buildAcceptancePlan('C:\\software-dev', 'run-1', true);
  assert.deepEqual(plan.map((item) => item.project), ['capture-workbench', 'cert-prep', 'law-prep']);
  assert.ok(plan.every((item) => item.target.endsWith(':acceptance-real-recorded')));
  assert.ok(plan.every((item) => item.artifactRoot.endsWith(`\\${item.project}\\run-1`)));
});

test('normal plan never enables recording', () => {
  const plan = buildAcceptancePlan('C:\\software-dev', 'run-2', false);
  assert.ok(plan.every((item) => item.target.endsWith(':acceptance-real')));
  assert.ok(plan.every((item) => item.environment.E2E_RECORD_VIDEO === '0'));
});

test('child manifest validation binds declared artifacts to on-disk bytes', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'three-project-acceptance-'));
  const payload = Buffer.from('screenshot-proof');
  await writeFile(join(artifactRoot, 'checkpoint.png'), payload);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const item = {
    project: 'capture-workbench' as const,
    cwd: artifactRoot,
    target: 'capture-workbench-desktop:acceptance-real',
    artifactRoot,
    environment: {},
  };
  const manifest = {
    schemaVersion: 1,
    project: 'capture-workbench',
    runId: 'run-1',
    status: 'completed',
    recordVideo: false,
    fixture: { name: 'fixture.pdf', sha256: 'a'.repeat(64) },
    cleanup: { app: true, sidecar: true, cdpPort: true, temporaryAppData: true },
    errors: [],
    consoleErrors: [],
    pageErrors: [],
    artifacts: [{ kind: 'screenshot', path: 'checkpoint.png', bytes: payload.length, sha256 }],
  };
  assert.equal(await validateChildManifest(manifest, item, 'run-1', false), true);
  assert.equal(await validateChildManifest({ ...manifest, artifacts: [{ ...manifest.artifacts[0], bytes: payload.length + 1 }] }, item, 'run-1', false), false);
  assert.equal(await validateChildManifest({ ...manifest, schemaVersion: 2 }, item, 'run-1', false), false);
});
