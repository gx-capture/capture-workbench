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
  assert.deepEqual(project.targets['dev-product'].dependsOn, [
    'stage-product-runtime',
  ]);
  assert.equal(project.targets.dev, undefined);
  assert.match(
    project.targets['build-nsis'].options.commands[0],
    /assert-staged-runtime\.ts --release/u,
  );
  assert.equal(project.targets['build-nsis-release'], undefined);
  assert.ok(
    project.targets['stage-deterministic-runtime'].outputs.some((output) =>
      output.endsWith('capture-document-v1.schema.json'),
    ),
  );
  assert.deepEqual(project.targets['package-qa'].dependsOn, [
    'build-nsis-deterministic',
  ]);
  assert.deepEqual(project.targets['smoke-real-ollama'].dependsOn, [
    'stage-product-runtime',
  ]);
  assert.match(
    project.targets['smoke-real-ollama'].metadata.description,
    /excluded from ordinary CI/u,
  );
  const directmlSmoke = project.targets['smoke-real-desktop-ocr-directml'];
  assert.match(directmlSmoke.metadata.description, /requires DirectML provenance/u);
  assert.match(
    directmlSmoke.options.commands.at(-1),
    /--expected-ocr-device windowsml-dml$/u,
  );
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

test('renderer IPC never receives the sidecar bearer token', async () => {
  const [commands, desktopHost] = await Promise.all([
    readFile(join(appRoot, 'src-tauri', 'src', 'commands.rs'), 'utf8'),
    readFile(
      join(
        appRoot,
        '..',
        'capture-workbench',
        'src',
        'app',
        'services',
        'desktop-runtime-client.service.ts',
      ),
      'utf8',
    ),
  ]);
  assert.doesNotMatch(commands, /pub fn backend_config/u);
  assert.doesNotMatch(desktopHost, /backend_config|bearerToken|Authorization/u);
  assert.match(commands, /runtime_create_capture/u);
  assert.match(desktopHost, /runtime_create_capture/u);
});

test('blocking native I/O is isolated behind async Tauri commands', async () => {
  const commands = await readFile(
    join(appRoot, 'src-tauri', 'src', 'commands.rs'),
    'utf8',
  );
  assert.match(commands, /tauri::async_runtime::spawn_blocking/u);
  for (const command of [
    'library_create_source',
    'library_update_capture',
    'library_list',
    'library_get',
    'library_export',
    'library_delete',
    'runtime_requirements',
    'runtime_start_installation',
    'runtime_get_installation',
    'runtime_create_capture',
    'runtime_get_capture',
    'runtime_cancel_capture',
    'runtime_get_raw',
    'runtime_get_result',
    'runtime_delete_capture',
  ]) {
    assert.match(commands, new RegExp(`pub async fn ${command}`, 'u'));
  }
  assert.match(commands, /pub fn desktop_runtime_status/u);
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

test('WindowsML bundle metadata is runtime-owned, never injected by the host', async () => {
  const workspaceRoot = join(appRoot, '..', '..');
  const [launcher, stageRuntime, releaseBuilder, requirements] =
    await Promise.all([
      readFile(join(appRoot, 'src-tauri', 'src', 'launcher.rs'), 'utf8'),
      readFile(join(appRoot, 'scripts', 'stage-runtime.ts'), 'utf8'),
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
      readFile(
        join(
          workspaceRoot,
          'packages',
          'capture-runtime',
          'src',
          'capture_runtime',
          'constants',
          'requirements.py',
        ),
        'utf8',
      ),
    ]);
  for (const source of [launcher, stageRuntime, releaseBuilder]) {
    assert.doesNotMatch(source, /CAPTURE_WINDOWSML_BUNDLE/u);
    assert.doesNotMatch(source, /runtimeRequirements/u);
  }
  assert.match(requirements, /WINDOWSML_BUNDLE_URL/u);
  assert.match(requirements, /WINDOWSML_BUNDLE_SHA256/u);
});

test('real Ollama smoke uses the capture contract and validates profile provenance', async () => {
  const source = await readFile(join(appRoot, 'scripts', 'real-ollama-smoke.ts'), 'utf8');
  assert.match(source, /form\.set\('sourceKind', 'pdf'\)/u);
  assert.match(source, /capture-workbench-qwen3\.5-4b-structure-v1/u);
  assert.match(source, /\^sha256:\[a-f0-9\]\{64\}/u);
  assert.doesNotMatch(source, /CAPTURE_WINDOWSML_BUNDLE/u);
});

test('deterministic runtime checks exact Host authority and canonical v1 names', async () => {
  const fixtureRoot = join(
    appRoot,
    'scripts',
    'fixtures',
    'deterministic-runtime',
    'src',
  );
  const [httpSource, contractSource, deterministicSource] = await Promise.all([
    readFile(join(fixtureRoot, 'http.rs'), 'utf8'),
    readFile(join(fixtureRoot, 'contract.rs'), 'utf8'),
    readFile(join(appRoot, 'scripts', 'deterministic-http.ts'), 'utf8'),
  ]);
  assert.match(httpSource, /rsplit_once\(':'\)/u);
  assert.doesNotMatch(httpSource, /fn normalized_host/u);
  assert.match(contractSource, /"captureId"/u);
  assert.match(contractSource, /const SCHEMA_VERSION: &str = "1"/u);
  assert.match(deterministicSource, /multipart\/form-data; boundary=/u);
  assert.match(deterministicSource, /'structuringMode'/u);
  assert.match(deterministicSource, /wrongAuthorityPortRejected/u);
});

test('release workflow is SHA-pinned, least-privilege, and runtime-first', async () => {
  const workspaceRoot = join(appRoot, '..', '..');
  const [
    workflow,
    releaseBuilder,
    executableBuilder,
    ciWorkflow,
    publisher,
    runtimeProject,
  ] =
    await Promise.all([
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
      readFile(
        join(
          workspaceRoot,
          'packages',
          'capture-runtime',
          'scripts',
          'build_executable.py',
        ),
        'utf8',
      ),
      readFile(join(workspaceRoot, '.github', 'workflows', 'ci.yml'), 'utf8'),
      readFile(join(workspaceRoot, 'tools', 'publish-release.ts'), 'utf8'),
      readFile(
        join(workspaceRoot, 'packages', 'capture-runtime', 'project.json'),
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
  assert.doesNotMatch(
    workflow,
    /clean-install|attestation|production-preflight/u,
  );
  assert.match(workflow, /publish:[\s\S]*needs: build-candidate/u);
  assert.match(workflow, /capture-workbench-desktop:build-nsis/u);
  assert.match(workflow, /gh release upload/u);
  assert.match(
    workflow,
    /publish:[\s\S]*contents: write[\s\S]*packages: write/u,
  );
  assert.equal((workflow.match(/contents: write/gu) ?? []).length, 1);
  assert.equal((workflow.match(/packages: write/gu) ?? []).length, 1);
  assert.match(ciWorkflow, /capture-workbench:test/u);
  assert.match(ciWorkflow, /capture-workbench:production-bundle-check/u);

  const project = JSON.parse(runtimeProject);
  assert.equal(project.targets['production-preflight'], undefined);
  assert.doesNotMatch(
    JSON.stringify(project.targets['build-release-artifacts'].dependsOn),
    /production-preflight/u,
  );
  assert.deepEqual(project.targets['generate-production-schema'].dependsOn, [
    'verify-production-environment',
  ]);
  assert.deepEqual(project.targets['build-production-executable'].dependsOn, [
    'verify-production-environment',
  ]);
  assert.deepEqual(project.targets['build-release-artifacts'].dependsOn, [
    'build-production-executable',
    'generate-production-schema',
  ]);
  assert.match(
    project.targets['prepare-production-environment'].options.command,
    /uv sync[\s\S]*--reinstall-package onnxruntime-directml/u,
  );
  for (const target of [
    'verify-production-environment',
    'generate-production-schema',
    'build-production-executable',
    'build-release-artifacts',
  ]) {
    assert.match(project.targets[target].options.command, /uv run --no-sync/u);
  }
  assert.doesNotMatch(
    releaseBuilder,
    /RuntimeSettings|OLLAMA_MODELS|WHISPER_MODELS/u,
  );
  assert.match(executableBuilder, /--collect-all[\s\S]*"pypdf"/u);
  assert.match(executableBuilder, /"pypdf",/u);
  assert.match(
    publisher,
    /preflightPackagePublication[\s\S]*ensureRuntimeReleasePublic[\s\S]*applyPackagePublication/u,
  );
});
