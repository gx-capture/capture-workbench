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

test('runtime candidate workflow excludes the desktop product lane', async () => {
  const runtimeWorkflow = await readFile(
    join(root, '.github/workflows/runtime-candidate.yml'),
    'utf8',
  );
  assert.doesNotMatch(
    runtimeWorkflow,
    /capture-workbench-desktop|tauri|nsis|windows-install/iu,
  );
  assert.match(runtimeWorkflow, /capture-runtime:build-release-artifacts/u);
  assert.match(
    runtimeWorkflow,
    /capture-sidecar-launcher:cargo-package-dry-run/u,
  );
  assert.match(runtimeWorkflow, /verify-runtime-candidate\.ts/u);
  assert.match(runtimeWorkflow, /capture-runtime-candidate-/u);
});

test('runtime promotion requires npm evidence before publishing runtime registries', async () => {
  const promoteWorkflow = await readFile(
    join(root, '.github/workflows/runtime-promote.yml'),
    'utf8',
  );
  const releaseWorkflow = await readFile(
    join(root, '.github/workflows/_publish-runtime-github-release.yml'),
    'utf8',
  );
  for (const content of [promoteWorkflow, releaseWorkflow]) {
    assert.doesNotMatch(
      content,
      /capture-workbench-desktop|tauri|nsis|windows-install/iu,
    );
    assert.match(content, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/u);
  }
  assert.match(promoteWorkflow, /package_promote_run_id/u);
  assert.match(promoteWorkflow, /registry-ledger-npm-/u);
  assert.match(promoteWorkflow, /publish-pypi/u);
  assert.match(promoteWorkflow, /publish-crates/u);
  assert.match(promoteWorkflow, /tag-runtime-release/u);
  assert.match(releaseWorkflow, /create-runtime-github-release\.ts/u);
  assert.match(releaseWorkflow, /promotion-input-/u);
});

test('desktop candidate consumes an exact Runtime Candidate', async () => {
  const candidateWorkflow = await readFile(
    join(root, '.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const promoteWorkflow = await readFile(
    join(root, '.github/workflows/release-promote.yml'),
    'utf8',
  );
  assert.match(candidateWorkflow, /runtime_candidate_run_id/u);
  assert.match(candidateWorkflow, /capture-runtime-candidate-/u);
  assert.match(candidateWorkflow, /verify-runtime-candidate\.ts/u);
  assert.match(candidateWorkflow, /--runtime-candidate-id/u);
  assert.match(
    candidateWorkflow,
    /--runtime-candidate "\$env:RUNTIME_CANDIDATE_PATH"/u,
  );
  assert.doesNotMatch(
    candidateWorkflow,
    /capture-runtime:build-release-artifacts/u,
  );
  assert.match(promoteWorkflow, /runtime_candidate_manifest_sha256/u);
  assert.match(promoteWorkflow, /verify-runtime-candidate-binding\.ts/u);
});
