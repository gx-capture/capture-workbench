import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');

function toolCommands(workflow: string, tool: string): readonly string[] {
  const lines = workflow.split(/\r?\n/u);
  return lines.flatMap((line, index) => {
    if (!line.includes(`node tools/${tool}`)) return [];
    const command = [line];
    let cursor = index + 1;
    while (
      /(?:`|\\)$/u.test(command.at(-1)?.trimEnd() ?? '') &&
      cursor < lines.length
    ) {
      command.push(lines[cursor] ?? '');
      cursor += 1;
    }
    return [command.join('\n')];
  });
}

test('package candidate workflow is independent from the desktop product lane', async () => {
  const candidateWorkflow = await readFile(
    join(root, '.github/workflows/package-candidate.yml'),
    'utf8',
  );
  const promoteWorkflow = await readFile(
    join(root, '.github/workflows/package-promote.yml'),
    'utf8',
  );
  const pypiWorkflow = await readFile(
    join(root, '.github/workflows/_publish-pypi.yml'),
    'utf8',
  );
  const releasePromoteWorkflow = await readFile(
    join(root, '.github/workflows/release-promote.yml'),
    'utf8',
  );
  for (const content of [candidateWorkflow, promoteWorkflow]) {
    assert.doesNotMatch(
      content,
      /capture-workbench-desktop|tauri|nsis|windows-install|ollama|whisper|model/iu,
    );
  }
  assert.match(candidateWorkflow, /capture-runtime-client-java:build/u);
  assert.match(candidateWorkflow, /capture-runtime-client-python:build/u);
  assert.match(candidateWorkflow, /capture-structuring-python:build/u);
  assert.match(
    candidateWorkflow,
    /astral-sh\/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b/u,
  );
  assert.match(candidateWorkflow, /python-version: '3\.12'/u);
  assert(
    candidateWorkflow.indexOf('astral-sh/setup-uv@') <
      candidateWorkflow.indexOf('capture-runtime-client-python:build'),
    'uv and Python must be installed before the Python package builds run.',
  );
  assert.match(candidateWorkflow, /assemble-java-sdk-candidate\.ts/u);
  assert(
    candidateWorkflow.indexOf('assemble-java-sdk-candidate.ts') <
      candidateWorkflow.indexOf('assemble-package-candidate.ts'),
    'The Java candidate must exist before the Package Candidate seals its complete artifact inventory.',
  );
  assert.match(candidateWorkflow, /capture-angular:clean-consumer-smoke/u);
  assert.match(candidateWorkflow, /pnpm exec playwright install chromium/u);
  assert.equal(
    [
      ...candidateWorkflow.matchAll(
        /if: \$\{\{ always\(\) && env\.PACKAGE_CANDIDATE_ID != '' \}\}/gu,
      ),
    ].length,
    3,
  );
  assert.match(promoteWorkflow, /candidate_kind: package/u);
  assert.match(promoteWorkflow, /publish-maven/u);
  assert.match(promoteWorkflow, /publish-pypi/u);
  assert.match(releasePromoteWorkflow, /pypi_project/u);
  assert.match(promoteWorkflow, /contract_set_sha256/u);
  assert.doesNotMatch(
    promoteWorkflow,
    /tag-release|publish-github-release|stable-pointer/u,
  );
  assert.match(pypiWorkflow, /inputs\.candidate_kind == 'package'/u);
  assert.match(pypiWorkflow, /capture-package-candidate-/u);
  assert.match(pypiWorkflow, /verify-package-candidate\.ts/u);
  assert.match(
    pypiWorkflow,
    /packages-dir: \$\{\{ runner\.temp \}\}\/pypi-python/u,
  );
  assert.match(pypiWorkflow, /python_project/u);
  assert.match(pypiWorkflow, /capture_runtime_client/u);
  assert.match(pypiWorkflow, /ledger_candidate_id/u);
  assert.match(pypiWorkflow, /client bootstrap ledger/u);
});

test('Maven publication and registry verification use the Java candidate identity', async () => {
  const publishMaven = await readFile(
    join(root, '.github/workflows/_publish-maven.yml'),
    'utf8',
  );
  const verifyRegistries = await readFile(
    join(root, '.github/workflows/_verify-registries.yml'),
    'utf8',
  );
  const releasePromote = await readFile(
    join(root, '.github/workflows/release-promote.yml'),
    'utf8',
  );
  assert.match(publishMaven, /candidateId:process\.env\.JAVA_CANDIDATE_ID/u);
  assert.match(publishMaven, /Probe GitHub Packages Maven authentication/u);
  assert.match(
    publishMaven,
    /GitHub Packages Maven authentication failed \(HTTP 401\)/u,
  );
  assert.match(verifyRegistries, /^\s{6}java_candidate_id:\s*$/mu);
  assert.match(
    verifyRegistries,
    /--java-candidate-id '\$\{\{ inputs\.java_candidate_id \}\}'/u,
  );
  assert.match(
    releasePromote,
    /^\s{6}java_candidate_id: \$\{\{ needs\.prepare-candidate\.outputs\.java_candidate_id \}\}\s*$/mu,
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
  assert.match(npmWorkflow, /registry=https:\/\/registry\.npmjs\.org\//u);
  assert.match(
    npmWorkflow,
    /@gx-capture:registry=https:\/\/npm\.pkg\.github\.com/u,
  );
  assert.doesNotMatch(
    npmWorkflow,
    /npm install --ignore-scripts --registry https:\/\/npm\.pkg\.github\.com/u,
  );
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
  const verificationCommands = toolCommands(
    runtimeWorkflow,
    'verify-runtime-candidate.ts',
  );
  assert.equal(verificationCommands.length, 1);
  assert.match(
    verificationCommands[0] ?? '',
    /--contract-set-sha256 '\$\{\{ inputs\.contract_set_sha256 \}\}'/u,
  );
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
  assert.match(
    promoteWorkflow,
    /l\.contractSetSha256!==['"]\$\{\{ inputs\.contract_set_sha256 \}\}['"]/u,
  );
  assert.match(
    promoteWorkflow,
    /l\.releaseCandidateId!==['"]\$\{\{ inputs\.package_candidate_id \}\}['"]/u,
  );
  assert.match(promoteWorkflow, /^\s{6}contract_set_sha256:\s*$/mu);
  const promotionVerifications = toolCommands(
    promoteWorkflow,
    'verify-runtime-candidate.ts',
  );
  assert.equal(promotionVerifications.length, 1);
  assert.match(
    promotionVerifications[0] ?? '',
    /--contract-set-sha256 '\$\{\{ inputs\.contract_set_sha256 \}\}'/u,
  );
  assert.equal(
    [
      ...promoteWorkflow.matchAll(
        /^\s{6}contract_set_sha256: \$\{\{ inputs\.contract_set_sha256 \}\}\s*$/gmu,
      ),
    ].length,
    2,
  );
  assert.match(promoteWorkflow, /publication_scope/u);
  assert.match(promoteWorkflow, /github-release/u);
  assert.match(promoteWorkflow, /inputs\.publication_scope == 'registries'/u);
  assert.match(promoteWorkflow, /publish-pypi/u);
  assert.match(promoteWorkflow, /publish-crates/u);
  assert.match(promoteWorkflow, /tag-runtime-release/u);
  assert.match(releaseWorkflow, /create-runtime-github-release\.ts/u);
  assert.match(releaseWorkflow, /promotion-input-/u);
  assert.match(releaseWorkflow, /tooling_commit/u);
  assert.match(promoteWorkflow, /tooling_commit: \$\{\{ github\.sha \}\}/u);
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
  const githubReleaseWorkflow = await readFile(
    join(root, '.github/workflows/_publish-github-release.yml'),
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
  assert.match(
    promoteWorkflow,
    /java_candidate_id: \$\{\{ needs\.prepare-candidate\.outputs\.java_candidate_id \}\}/u,
  );
  assert.match(
    githubReleaseWorkflow,
    /--java-candidate-id '\$\{\{ inputs\.java_candidate_id \}\}'/u,
  );
  const promotedRuntimeVerifications = toolCommands(
    promoteWorkflow,
    'verify-runtime-candidate.ts',
  );
  assert.equal(promotedRuntimeVerifications.length, 1);
  assert.match(
    promotedRuntimeVerifications[0] ?? '',
    /--contract-set-sha256 '\$\{\{ inputs\.contract_set_sha256 \}\}'/u,
  );
  const releaseVerifications = toolCommands(
    candidateWorkflow,
    'verify-release-candidate.ts',
  );
  assert.equal(releaseVerifications.length, 5);
  for (const command of releaseVerifications) {
    assert.match(
      command,
      /--contract-set-sha256 '\$\{\{ inputs\.contract_set_sha256 \}\}'/u,
    );
  }
});
