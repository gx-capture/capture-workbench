import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertWebmArtifact,
  createAcceptanceRun,
  redactAcceptanceText,
  sha256File,
  writeAcceptanceManifest,
} from './acceptance-contract.ts';

test('acceptance run defaults to the isolated project output root', () => {
  const run = createAcceptanceRun(
    {
      E2E_ACCEPTANCE_RUN_ID: 'run-2026-08-17',
      E2E_RECORD_VIDEO: '0',
    },
    'capture-workbench',
    'C:\\software-dev\\capture-workbench',
  );

  assert.equal(run.runId, 'run-2026-08-17');
  assert.equal(run.recordVideo, false);
  assert.match(run.artifactRoot, /output[\\/]playwright[\\/]capture-workbench[\\/]run-2026-08-17$/u);
});

test('recorded acceptance requires an explicit valid run id', () => {
  assert.throws(
    () => createAcceptanceRun({ E2E_RECORD_VIDEO: '1' }, 'capture-workbench', process.cwd()),
    /E2E_ACCEPTANCE_RUN_ID/u,
  );
  assert.throws(
    () => createAcceptanceRun({ E2E_ACCEPTANCE_RUN_ID: '../escape' }, 'capture-workbench', process.cwd()),
    /run ID/u,
  );
});

test('WebM validation and SHA-256 are fail-closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-contract-'));
  const video = join(root, 'journey.webm');
  await writeFile(video, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]));

  assert.equal(await assertWebmArtifact(video), true);
  assert.match(await sha256File(video), /^[a-f0-9]{64}$/u);

  const invalid = join(root, 'invalid.webm');
  await writeFile(invalid, Buffer.from('not a video'));
  await assert.rejects(() => assertWebmArtifact(invalid), /EBML\/WebM/u);
});

test('manifest writing redacts secrets and absolute paths from text artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-manifest-'));
  const screenshot = join(root, 'ready.png');
  await writeFile(screenshot, Buffer.from('png'));
  const log = join(root, 'console-errors.json');
  await writeFile(log, JSON.stringify({
    message: 'Authorization: Bearer secret-token with "quoted" text',
    token: 'raw-secret',
    path: 'C:\\Users\\Private\\fixture.pdf',
    nested: {
      authorization: 'Bearer nested-secret with "escaped" quotes',
      client_secret: 'raw-client-secret',
    },
  }));

  const manifestPath = await writeAcceptanceManifest(root, {
    project: 'capture-workbench',
    runId: 'run-1',
    status: 'completed',
    recordVideo: false,
    artifacts: [
      { path: screenshot, kind: 'screenshot' },
      { path: log, kind: 'log' },
    ],
    errors: ['Authorization: Bearer secret-token C:\\Users\\Private\\fixture.pdf'],
    cleanup: { app: true, sidecar: true, cdpPort: true, temporaryAppData: true },
  });

  const contents = await import('node:fs/promises').then(({ readFile: read }) => read(manifestPath, 'utf8'));
  assert.doesNotMatch(contents, /secret-token|C:\\Users\\Private/u);
  const redactedLog = await import('node:fs/promises').then(({ readFile: read }) => read(log, 'utf8'));
  assert.doesNotMatch(
    redactedLog,
    /secret-token|raw-secret|raw-client-secret|nested-secret|C:\\Users\\Private/u,
  );
  assert.doesNotThrow(() => JSON.parse(redactedLog));
  assert.match(contents, /"status": "completed"/u);
});

test('redaction is stable for bearer tokens and local paths', () => {
  const redacted = redactAcceptanceText(
    'Bearer abc.def.ghi at C:\\Users\\Alice\\fixture.pdf and /private/data/file.pdf',
  );
  assert.equal(redacted.includes('abc.def.ghi'), false);
  assert.equal(redacted.includes('C:\\Users\\Alice'), false);
  assert.equal(redacted.includes('/private/data'), false);
});
