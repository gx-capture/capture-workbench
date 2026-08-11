import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');

test('package candidate workflow is independent from the desktop product lane', async () => {
  const candidateWorkflow = await readFile(
    join(root, '.github/workflows/package-candidate.yml'),
    'utf8',
  );
  const promoteWorkflow = await readFile(
    join(root, '.github/workflows/package-promote.yml'),
    'utf8',
  );
  for (const content of [candidateWorkflow, promoteWorkflow]) {
    assert.doesNotMatch(
      content,
      /capture-runtime|capture-workbench-desktop|tauri|nsis|windows-install|ollama|whisper|model/iu,
    );
  }
  assert.match(candidateWorkflow, /capture-angular:clean-consumer-smoke/u);
  assert.match(promoteWorkflow, /candidate_kind: package/u);
  assert.doesNotMatch(
    promoteWorkflow,
    /tag-release|publish-github-release|stable-pointer/u,
  );
});

test('npm publication accepts a package candidate without making it a desktop candidate', async () => {
  const npmWorkflow = await readFile(
    join(root, '.github/workflows/_publish-npm.yml'),
    'utf8',
  );
  assert.match(npmWorkflow, /inputs\.candidate_kind == 'package'/u);
  assert.match(npmWorkflow, /capture-package-candidate-/u);
  assert.match(npmWorkflow, /verify-package-candidate\.ts/u);
  assert.match(npmWorkflow, /Release Package Candidate/u);
});
