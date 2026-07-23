import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { assertRedactedEvidence } from './package-qa.ts';
import { appRoot } from './stage-runtime.ts';

test('Nx separates root verification build from release and deterministic NSIS lanes', async () => {
  const project = JSON.parse(
    await readFile(join(appRoot, 'project.json'), 'utf8'),
  );
  assert.match(project.targets.build.options.command, /--no-bundle/u);
  assert.doesNotMatch(project.targets.build.options.command, /deterministic/u);
  assert.deepEqual(project.targets['build-nsis-deterministic'].dependsOn, [
    'stage-deterministic-runtime',
  ]);
  assert.deepEqual(project.targets['dev-deterministic'].dependsOn, [
    'stage-deterministic-runtime',
  ]);
  assert.match(
    project.targets['build-nsis-release'].options.commands[0],
    /assert-staged-runtime\.ts --release/u,
  );
  assert.ok(
    project.targets['stage-deterministic-runtime'].outputs.some((output) =>
      output.endsWith('capture-document-v1.schema.json'),
    ),
  );
  assert.deepEqual(project.targets['package-qa'].dependsOn, [
    'build-nsis-deterministic',
  ]);
});

test('production CSP is strict while allowing only dynamic loopback API ports', async () => {
  const config = JSON.parse(
    await readFile(join(appRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const csp = config.app.security.csp;
  assert.match(csp, /default-src 'self'/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/u);
  assert.doesNotMatch(csp, /unsafe-eval|https:\/\/|wss:\/\//u);
  assert.doesNotMatch(csp, /(?:^|[ ;])\*(?:[ ;]|$)/u);
  assert.deepEqual(config.bundle.targets, ['nsis']);
  assert.match(
    config.build.beforeBuildCommand,
    /capture-workbench:production-bundle-check/u,
  );
});

test('QA evidence rejects authorization material', () => {
  assert.doesNotThrow(() =>
    assertRedactedEvidence({
      runtime: { sha256: '0'.repeat(64) },
      releaseGateSatisfied: false,
    }),
  );
  assert.throws(
    () => assertRedactedEvidence({ authorization: 'Bearer should-not-appear' }),
    /authorization material/u,
  );
});

test('native cleanup is PID-scoped and never executable-name scoped', async () => {
  const source = await readFile(
    join(appRoot, 'src-tauri', 'src', 'process.rs'),
    'utf8',
  );
  assert.match(source, /"\/PID"/u);
  assert.match(source, /"\/T"/u);
  assert.doesNotMatch(source, /"\/IM"\s*,/u);
});

test('desktop launcher advertises the bounded 50 MiB upload policy', async () => {
  const constants = await readFile(
    join(appRoot, 'src-tauri', 'src', 'constants', 'runtime.rs'),
    'utf8',
  );
  const launchPolicy = await readFile(
    join(appRoot, 'src-tauri', 'src', 'launch_policy.rs'),
    'utf8',
  );
  assert.match(
    constants,
    /DEFAULT_MAX_UPLOAD_BYTES:\s*u64\s*=\s*50\s*\*\s*1024\s*\*\s*1024/u,
  );
  assert.match(launchPolicy, /"CAPTURE_MAX_UPLOAD_BYTES"/u);
  assert.match(launchPolicy, /DEFAULT_MAX_UPLOAD_BYTES\.to_string\(\)/u);
});

test('deterministic runtime checks exact Host authority and canonical v1 names', async () => {
  const fixtureRoot = join(
    appRoot,
    'scripts',
    'fixtures',
    'deterministic-runtime',
    'src',
  );
  const [httpSource, contractSource, smokeSource] = await Promise.all([
    readFile(join(fixtureRoot, 'http.rs'), 'utf8'),
    readFile(join(fixtureRoot, 'contract.rs'), 'utf8'),
    readFile(join(appRoot, 'scripts', 'deterministic-smoke.ts'), 'utf8'),
  ]);
  assert.match(httpSource, /rsplit_once\(':'\)/u);
  assert.doesNotMatch(httpSource, /fn normalized_host/u);
  assert.match(contractSource, /"captureId"/u);
  assert.match(contractSource, /const SCHEMA_VERSION: &str = "1"/u);
  assert.match(smokeSource, /multipart\/form-data; boundary=/u);
  assert.match(smokeSource, /'structuringMode'/u);
  assert.match(smokeSource, /wrongAuthorityPortRejected/u);
});

test('release workflow is SHA-pinned, least-privilege, attested, and runtime-first', async () => {
  const workspaceRoot = join(appRoot, '..', '..');
  const [
    workflow,
    releaseBuilder,
    ciWorkflow,
    publisher,
    runtimeProject,
    preflight,
  ] = await Promise.all([
    readFile(
      join(workspaceRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    ),
    readFile(
      join(
        workspaceRoot,
        'packages',
        'capture-runtime',
        'scripts',
        'build_release_artifacts.py',
      ),
      'utf8',
    ),
    readFile(join(workspaceRoot, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFile(join(workspaceRoot, 'tools', 'publish-release.ts'), 'utf8'),
    readFile(
      join(workspaceRoot, 'packages', 'capture-runtime', 'project.json'),
      'utf8',
    ),
    readFile(
      join(
        workspaceRoot,
        'packages',
        'capture-runtime',
        'scripts',
        'production_preflight.py',
      ),
      'utf8',
    ),
  ]);
  const actionReferences = [workflow, ciWorkflow].flatMap((source) =>
    [...source.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)].map(
      (match) => match[1],
    ),
  );
  assert.ok(actionReferences.length >= 8);
  assert.ok(
    actionReferences.every((reference) => /^[0-9a-f]{40}$/u.test(reference)),
  );
  assert.match(workflow, /permissions:\s*\r?\n\s+contents: read/u);
  assert.match(
    workflow,
    /verify-clean-install-evidence:[\s\S]*needs: build-candidate/u,
  );
  assert.match(
    workflow,
    /publish:[\s\S]*needs: verify-clean-install-evidence/u,
  );
  assert.match(
    workflow,
    /publish:[\s\S]*contents: write[\s\S]*packages: write/u,
  );
  assert.equal((workflow.match(/contents: write/gu) ?? []).length, 1);
  assert.equal((workflow.match(/packages: write/gu) ?? []).length, 1);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /capture-runtime:production-preflight/u);
  assert.match(ciWorkflow, /capture-workbench:test/u);
  assert.match(ciWorkflow, /capture-workbench:production-bundle-check/u);

  const project = JSON.parse(runtimeProject);
  assert.doesNotMatch(
    JSON.stringify(project.targets['build-release-artifacts'].dependsOn),
    /production-preflight/u,
  );
  assert.doesNotMatch(
    preflight,
    /assets_ready|whisper_models_dir|windowsml_model_dir/u,
  );
  assert.doesNotMatch(
    releaseBuilder,
    /RuntimeSettings|OLLAMA_MODELS|WHISPER_MODELS/u,
  );
  assert.match(
    publisher,
    /const packagePlan = await preflightPackagePublication[\s\S]*await ensureRuntimeReleasePublic[\s\S]*await applyPackagePublication/u,
  );
});
