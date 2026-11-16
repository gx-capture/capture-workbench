import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  importModelSmokeFixtureDocument,
  REAL_MODEL_SOURCE_IMPORT_MODE,
} from './real-media-model-smoke.ts';

test('model smoke feature is declared in Cargo.toml', async () => {
  const cargo = await readFile(
    new URL('../src-tauri/Cargo.toml', import.meta.url),
    'utf8',
  );
  assert.match(cargo, /model-smoke-app-data\s*=\s*\[\]/u);
});

test('model smoke launcher uses only keyed injection and labels the picker bypass', async () => {
  const calls: Array<{ command: string; args: Readonly<Record<string, unknown>> }> = [];
  const documentId = 'a'.repeat(32);
  const importedId = await importModelSmokeFixtureDocument('pdf', async (command, args) => {
    calls.push({ command, args });
    return { documentId };
  });
  assert.equal(importedId, documentId);
  assert.deepEqual(calls, [
    {
      command: 'model_smoke_import_fixture',
      args: { request: { fixtureKey: 'pdf' } },
    },
  ]);
  assert.equal(
    REAL_MODEL_SOURCE_IMPORT_MODE,
    'deterministic-feature-gated-picker-bypass',
  );

  const projectText = await readFile(
    new URL('../project.json', import.meta.url),
    'utf8',
  );
  const project = JSON.parse(projectText) as {
    targets: Record<string, { options: { command?: string }; metadata?: { description?: string } }>;
  };
  assert.match(
    project.targets['build-model-smoke'].options.command ?? '',
    /--features model-smoke-app-data/u,
  );
  assert.doesNotMatch(
    project.targets.build.options.command ?? '',
    /model-smoke-app-data/u,
  );
  assert.match(
    project.targets['smoke-real-media-model'].metadata?.description ?? '',
    /deterministic picker bypass/u,
  );
});
