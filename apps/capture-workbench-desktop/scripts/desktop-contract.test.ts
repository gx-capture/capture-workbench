import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { assertRedactedEvidence } from './package-qa.ts';
import { appRoot } from './stage-runtime.ts';

const workflowBlockScalarHeader =
  /^[|>](?:(?:[+-][1-9]?)|(?:[1-9][+-]?))?(?:\s+#.*)?$/u;

function isWorkflowBlockScalarHeader(value: string): boolean {
  return workflowBlockScalarHeader.test(value.trim());
}

function workflowRunScripts(source: string): string[] {
  const lines = source.split(/\r?\n/u);
  const scripts: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const run = /^(?<indent>\s*)(?<listMarker>-\s+)?run:\s*(?<value>.*)$/u.exec(
      lines[index],
    );
    if (!run?.groups) continue;
    const indentation =
      run.groups['indent'].length + (run.groups['listMarker']?.length ?? 0);
    const value = run.groups['value'].trim();
    if (!isWorkflowBlockScalarHeader(value)) {
      scripts.push(value);
      continue;
    }
    const block: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      const nextIndentation = /^\s*/u.exec(next)?.[0].length ?? 0;
      if (next.trim().length > 0 && nextIndentation <= indentation) break;
      block.push(next);
      index += 1;
    }
    scripts.push(block.join('\n'));
  }
  return scripts;
}

interface WorkflowStep {
  readonly blockRun: boolean;
  readonly condition?: string;
  readonly name: string;
  readonly script?: string;
  readonly shell?: string;
  readonly source: string;
}

function workflowNamedSteps(source: string): WorkflowStep[] {
  const lines = source.split(/\r?\n/u);
  const steps: WorkflowStep[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = /^(?<indent>\s*)- name:\s*(?<name>.+)$/u.exec(lines[index]);
    if (!start?.groups) continue;
    const indentation = start.groups['indent'].length;
    const block = [lines[index]];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      const nextIndentation = /^\s*/u.exec(next)?.[0].length ?? 0;
      if (next.trim().length > 0 && nextIndentation <= indentation) break;
      block.push(next);
      index += 1;
    }
    const stepSource = block.join('\n');
    const script = workflowRunScripts(stepSource)[0];
    const shell = /^\s*shell:\s*(?<shell>\S+)\s*$/mu.exec(stepSource)?.groups?.[
      'shell'
    ];
    const condition = /^\s*if:\s*(?<condition>.+?)\s*$/mu.exec(stepSource)
      ?.groups?.['condition'];
    const runValue = /^\s*run:\s*(?<value>.*)$/mu.exec(stepSource)?.groups?.[
      'value'
    ];
    steps.push({
      blockRun: isWorkflowBlockScalarHeader(runValue ?? ''),
      condition,
      name: start.groups['name'].trim(),
      script,
      shell,
      source: stepSource,
    });
  }
  return steps;
}

function requiredWorkflowStep(
  steps: readonly WorkflowStep[],
  name: string,
): WorkflowStep {
  const matches = steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, `Expected one workflow step named ${name}.`);
  return matches[0];
}

function nativeCommandLines(script: string): string[] {
  return script
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:cargo|gh|git|node|npm|pnpm|rustup|uv)\b/u.test(line));
}

function invokesFullWorkspaceVerify(line: string): boolean {
  return /^(?:corepack\s+)?pnpm(?:\s+(?!verify(?=\s|$))\S+)*\s+verify(?=\s|$)/u.test(
    line.trim(),
  );
}

function assertNativeErrorPreferenceWindow(
  script: string,
  expectedInvocation: RegExp,
  expectedExitCapture: string,
  expectedBranch: string,
): void {
  const lines = script
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const disabledIndexes = lines
    .map((line, index) =>
      line === '$PSNativeCommandUseErrorActionPreference = $false'
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  assert.equal(
    disabledIndexes.length,
    1,
    'Expected exactly one intentional native-error preference disable.',
  );
  const disabledIndex = disabledIndexes[0];
  assert.match(lines[disabledIndex + 1] ?? '', expectedInvocation);
  assert.equal(lines[disabledIndex + 2], expectedExitCapture);
  assert.equal(
    lines[disabledIndex + 3],
    '$PSNativeCommandUseErrorActionPreference = $true',
  );
  assert.equal(lines[disabledIndex + 4], expectedBranch);
}

test('workflow run extraction covers compact steps and every valid block scalar header', () => {
  const expression = '${{ github.ref_name }}';
  assert.deepEqual(
    workflowRunScripts(
      ['steps:', `  - run: echo "${expression}"`, '  - name: next'].join('\n'),
    ),
    [`echo "${expression}"`],
  );

  for (const blockIndicator of [
    '|',
    '|-',
    '|+',
    '|2',
    '|-2',
    '|2-',
    '|+2',
    '|2+',
    '| # literal comment',
    '>',
    '>-',
    '>+',
    '>2',
    '>-2',
    '>2-',
    '>+2',
    '>2+',
    '> # folded comment',
  ]) {
    const workflow = [
      'steps:',
      '  - name: scalar step',
      '    shell: pwsh',
      `    run: ${blockIndicator}`,
      `      echo "${expression}"`,
      '      node tools/check.mjs',
      '    env:',
      `      SAFE_CONTEXT: ${expression}`,
      '  - name: next',
      '    run: echo next-step',
    ].join('\n');
    assert.deepEqual(
      workflowRunScripts(workflow),
      [`      echo "${expression}"\n      node tools/check.mjs`, 'echo next-step'],
      blockIndicator,
    );
    const scalarStep = requiredWorkflowStep(
      workflowNamedSteps(workflow),
      'scalar step',
    );
    assert.equal(scalarStep.blockRun, true, blockIndicator);
    assert.equal(
      scalarStep.script,
      `      echo "${expression}"\n      node tools/check.mjs`,
      blockIndicator,
    );
  }
});

test('release command detection rejects full verify variants but permits the version script', () => {
  for (const command of [
    'pnpm verify',
    'pnpm verify --filter capture-runtime',
    'pnpm --silent verify -- --changed',
    'pnpm run verify --reporter append-only',
    'corepack pnpm verify',
    'corepack pnpm --silent run verify --filter capture-angular',
  ]) {
    assert.equal(invokesFullWorkspaceVerify(command), true, command);
  }
  assert.equal(
    invokesFullWorkspaceVerify(
      'pnpm verify:release-version -- "$env:RELEASE_TAG"',
    ),
    false,
  );
});

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
  assert.match(
    directmlSmoke.metadata.description,
    /requires DirectML provenance/u,
  );
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
  assert.deepEqual(config.bundle.resources, [
    'binaries/capture-runtime-x86_64-pc-windows-msvc.exe',
    'resources/capture-runtime-manifest.json',
    'resources/capture-document-v1.schema.json',
  ]);
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
    'library_import_source',
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

test('native source import keeps renderer IPC path-only and responses path-free', async () => {
  const workspaceRoot = join(appRoot, '..', '..');
  const [renderer, contracts, library, capability, desktopHost] =
    await Promise.all([
      readFile(
        join(
          workspaceRoot,
          'apps',
          'capture-workbench',
          'src',
          'app',
          'services',
          'desktop-library.service.ts',
        ),
        'utf8',
      ),
      readFile(
        join(appRoot, 'src-tauri', 'src', 'contracts', 'library.rs'),
        'utf8',
      ),
      readFile(join(appRoot, 'src-tauri', 'src', 'library.rs'), 'utf8'),
      readFile(
        join(appRoot, 'src-tauri', 'capabilities', 'default.json'),
        'utf8',
      ),
      readFile(join(appRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    ]);
  const capabilityContract = JSON.parse(capability);
  assert.deepEqual(capabilityContract.windows, ['main']);
  assert.deepEqual(capabilityContract.permissions, [
    'core:default',
    'dialog:allow-open',
  ]);
  assert.doesNotMatch(
    JSON.stringify(capabilityContract.permissions),
    /dialog:(?:default|allow-(?:ask|confirm|message|save))/u,
  );
  assert.match(desktopHost, /plugin\(tauri_plugin_dialog::init\(\)\)/u);
  assert.match(renderer, /open\(\{[\s\S]*multiple: true/u);
  assert.match(renderer, /onDragDropEvent/u);
  assert.match(renderer, /library_import_source/u);
  assert.match(renderer, /request: \{ sourcePath \}/u);
  assert.doesNotMatch(
    renderer,
    /arrayBuffer\(|Array\.from\(|Uint8Array|FileList/u,
  );
  const summary = contracts.match(
    /pub struct LibraryDocumentSummary \{(?<body>[\s\S]*?)\r?\n\}/u,
  )?.groups?.['body'];
  assert.ok(summary);
  assert.doesNotMatch(summary, /path|bytes/u);
  assert.match(library, /fs::canonicalize/u);
  assert.match(library, /take\(MAX_SOURCE_BYTES as u64 \+ 1\)/u);
  assert.match(library, /verified_media_type/u);
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

test('WindowsML bundle provenance is runtime-owned without a hard-coded release URL', async () => {
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
  assert.doesNotMatch(requirements, /WINDOWSML_BUNDLE_URL/u);
  assert.doesNotMatch(requirements, /capture-windowsml-ocr-windows-x64\.zip/u);
  assert.match(requirements, /WINDOWSML_BUNDLE_SHA256/u);
});

test('real Ollama smoke uses the capture contract and validates profile provenance', async () => {
  const source = await readFile(
    join(appRoot, 'scripts', 'real-ollama-smoke.ts'),
    'utf8',
  );
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
  const actionReferences = [
    workflow,
    ciWorkflow,
  ].flatMap((source) =>
    [...source.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)].map(
      (match) => match[1],
    ),
  );
  assert.ok(actionReferences.length >= 13);
  assert.ok(
    actionReferences.every((reference) => /^[0-9a-f]{40}$/u.test(reference)),
  );
  assert.match(workflow, /permissions:\s*\r?\n\s+contents: read/u);
  assert.match(
    workflow,
    /build-candidate:[\s\S]*permissions:[\s\S]*actions: read[\s\S]*contents: read/u,
  );
  assert.doesNotMatch(
    workflow,
    /clean-install|attestation|production-preflight/u,
  );
  assert.match(workflow, /publish:[\s\S]*needs: build-candidate/u);
  assert.match(workflow, /fetch-depth: 0/u);
  const fetchMainIndex = workflow.indexOf(
    'git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main',
  );
  const mergeBaseIndex = workflow.indexOf('git merge-base --is-ancestor');
  const installPnpmIndex = workflow.indexOf('Install pnpm');
  const installNodeIndex = workflow.indexOf('Install Node.js');
  const installUvIndex = workflow.indexOf('Install uv and Python 3.12');
  assert.ok(fetchMainIndex >= 0);
  assert.ok(fetchMainIndex < mergeBaseIndex);
  assert.ok(mergeBaseIndex < installPnpmIndex);
  assert.ok(
    workflow.indexOf('Verify tag commit belongs to main') < installPnpmIndex,
  );
  assert.match(workflow, /git merge-base --is-ancestor/u);
  const exactMainCiIndex = workflow.indexOf(
    'Verify successful exact-commit main CI',
  );
  const classifyModeIndex = workflow.indexOf(
    'Classify canonical release model mode',
  );
  assert.ok(installPnpmIndex < installNodeIndex);
  assert.ok(installNodeIndex < exactMainCiIndex);
  assert.ok(exactMainCiIndex < installUvIndex);
  assert.ok(installUvIndex < classifyModeIndex);
  const buildRuntimeIndex = workflow.indexOf(
    'Build production runtime artifacts without ambient model stores',
  );
  assert.ok(classifyModeIndex < buildRuntimeIndex);
  assert.match(
    workflow,
    /verify-main-ci\.ts[\s\S]*--workflow-path "\.github\/workflows\/ci\.yml"[\s\S]*--branch "main"/u,
  );
  assert.match(
    workflow,
    /Classify canonical release model mode[\s\S]*capture-runtime:classify-release-model-mode[\s\S]*releaseMode[\s\S]*core-only[\s\S]*model-enabled/u,
  );
  const buildInstallerIndex = workflow.indexOf(
    'Build Capture Workbench Windows installer',
  );
  assert.ok(buildInstallerIndex > buildRuntimeIndex);
  const retainedReleaseStepNames = [
    'Verify tag commit belongs to main',
    'Install pnpm',
    'Install Node.js',
    'Verify successful exact-commit main CI',
    'Install uv and Python 3.12',
    'Install workspace dependencies',
    'Verify synchronized versions',
    'Classify canonical release model mode',
    'Build production runtime artifacts without ambient model stores',
    'Build Capture Workbench Windows installer with the verified release runtime',
    'Measure exact installed size',
    'Verify exact installed size and packaging budgets',
    'Assemble release candidate',
    'Upload release candidate',
    'Download release candidate',
    'Install publication script dependencies',
    'Publish runtime first, then the exact Capture Workbench package idempotently',
  ];
  const retainedReleaseStepIndexes = retainedReleaseStepNames.map((name) => {
    const index = workflow.indexOf(`- name: ${name}`);
    assert.ok(index >= 0, `Missing retained release step: ${name}`);
    return index;
  });
  for (let index = 1; index < retainedReleaseStepIndexes.length; index += 1) {
    assert.ok(
      retainedReleaseStepIndexes[index - 1] <
        retainedReleaseStepIndexes[index],
      `Release step order is invalid around ${retainedReleaseStepNames[index]}`,
    );
  }
  assert.doesNotMatch(workflow, /model-candidate\.yml|CAPTURE_MODEL_RECEIPT|trusted model candidate/u);
  const releaseRunScripts = workflowRunScripts(workflow);
  assert.doesNotMatch(releaseRunScripts.join('\n'), /\$\{\{/u);
  const normalizedReleaseRunLines = releaseRunScripts.flatMap((script) =>
    script.split(/\r?\n/u).map((line) => line.trim()),
  );
  assert.equal(
    normalizedReleaseRunLines.some((line) => invokesFullWorkspaceVerify(line)),
    false,
  );
  assert.ok(
    normalizedReleaseRunLines.includes('pnpm install --frozen-lockfile'),
  );
  assert.ok(
    normalizedReleaseRunLines.includes(
      'pnpm verify:release-version -- "$env:RELEASE_TAG"',
    ),
  );
  assert.ok(
    normalizedReleaseRunLines.includes(
      'pnpm nx run capture-runtime:build-release-artifacts',
    ),
  );
  assert.match(
    workflow,
    /Verify synchronized versions[\s\S]*env:\s*\r?\n\s+RELEASE_TAG: \$\{\{ github\.ref_name \}\}[\s\S]*run: pnpm verify:release-version -- "\$env:RELEASE_TAG"/u,
  );
  assert.match(
    workflow,
    /Assemble release candidate[\s\S]*env:\s*\r?\n\s+RELEASE_MODEL_MODE: \$\{\{ steps\.release-model-mode\.outputs\.mode \}\}[\s\S]*\$env:RELEASE_MODEL_MODE/u,
  );
  assert.match(
    workflow,
    /Publish runtime first[\s\S]*RELEASE_TAG: \$\{\{ github\.ref_name \}\}[\s\S]*--tag "\$env:RELEASE_TAG"/u,
  );
  assert.equal(
    (
      workflow.match(
        /name: capture-candidate-\$\{\{ github\.ref_name \}\}/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.match(workflow, /compression-level: 0/u);
  assert.match(workflow, /retention-days: 1/u);
  assert.match(workflow, /capture-workbench-desktop:build-nsis/u);
  assert.match(workflow, /installed-deterministic-smoke\.ts --measure-release-size/u);
  assert.match(workflow, /capture-runtime:size-regression-check/u);
  assert.match(workflow, /capture-angular:pack/u);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /publish-release\.ts/u);
  assert.match(workflow, /--installer \$installers\[0\]\.FullName/u);
  assert.doesNotMatch(workflow, /--clobber|gh release upload/u);
  assert.match(
    workflow,
    /publish:[\s\S]*contents: write[\s\S]*packages: write/u,
  );
  assert.equal((workflow.match(/contents: write/gu) ?? []).length, 1);
  assert.equal((workflow.match(/packages: write/gu) ?? []).length, 1);
  assert.match(ciWorkflow, /capture-workbench:test/u);
  assert.match(ciWorkflow, /capture-workbench:production-bundle-check/u);
  assert.match(ciWorkflow, /branches: \[main, develop\]/u);

  const ciSteps = workflowNamedSteps(ciWorkflow);
  const releaseSteps = workflowNamedSteps(workflow);
  const installedSizeCommand =
    'node apps/capture-workbench-desktop/scripts/installed-deterministic-smoke.ts --measure-release-size';
  const ciInstallerIndex = ciSteps.findIndex(
    (step) => step.name === 'Build and verify the core-only Windows installer',
  );
  const ciDesktopIndex = ciSteps.findIndex(
    (step) => step.name === 'Verify Capture Workbench desktop product',
  );
  const ciReferenceIndex = ciSteps.findIndex(
    (step) => step.name === 'Verify reference flow',
  );
  const ciDiagnosticsIndex = ciSteps.findIndex(
    (step) => step.name === 'Upload runtime packaging diagnostics',
  );
  requiredWorkflowStep(
    ciSteps,
    'Build and verify the core-only Windows installer',
  );
  assert.ok(ciInstallerIndex < ciDesktopIndex);
  assert.ok(ciDesktopIndex < ciReferenceIndex);
  assert.ok(ciReferenceIndex < ciDiagnosticsIndex);
  assert.equal(
    ciSteps.some((step) => step.name === 'Measure exact installed size'),
    false,
  );
  assert.equal(
    ciSteps.some((step) => step.name === 'Verify measured size budgets'),
    false,
  );
  assert.doesNotMatch(ciWorkflow, /installed-deterministic-smoke\.ts --measure-release-size/u);
  assert.doesNotMatch(ciWorkflow, /capture-runtime:size-regression-check/u);
  const ciDiagnosticsStep = requiredWorkflowStep(
    ciSteps,
    'Upload runtime packaging diagnostics',
  );
  assert.equal(ciDiagnosticsStep.condition, 'always()');
  assert.match(ciDiagnosticsStep.source, /if-no-files-found:\s*warn/u);
  assert.doesNotMatch(ciDiagnosticsStep.source, /continue-on-error:\s*true/u);
  assert.doesNotMatch(ciDiagnosticsStep.source, /runtime-size-report\.json/u);
  assert.doesNotMatch(ciDiagnosticsStep.source, /installed-size\.json/u);
  for (const stepName of [
    'Verify Capture Workbench desktop product',
    'Verify reference flow',
  ]) {
    assert.equal(
      requiredWorkflowStep(ciSteps, stepName).condition,
      undefined,
      `${stepName} must remain unconditional in ordinary CI.`,
    );
  }

  const releaseInstallerIndex = releaseSteps.findIndex(
    (step) =>
      step.name ===
      'Build Capture Workbench Windows installer with the verified release runtime',
  );
  const releaseMeasureIndex = releaseSteps.findIndex(
    (step) => step.name === 'Measure exact installed size',
  );
  const releaseSizeValidationIndex = releaseSteps.findIndex(
    (step) => step.name === 'Verify exact installed size and packaging budgets',
  );
  const releaseAssembleIndex = releaseSteps.findIndex(
    (step) => step.name === 'Assemble release candidate',
  );
  const releaseUploadIndex = releaseSteps.findIndex(
    (step) => step.name === 'Upload release candidate',
  );
  const releaseDownloadIndex = releaseSteps.findIndex(
    (step) => step.name === 'Download release candidate',
  );
  const releasePublishIndex = releaseSteps.findIndex(
    (step) =>
      step.name ===
      'Publish runtime first, then the exact Capture Workbench package idempotently',
  );
  requiredWorkflowStep(
    releaseSteps,
    'Build Capture Workbench Windows installer with the verified release runtime',
  );
  assert.ok(releaseInstallerIndex < releaseMeasureIndex);
  assert.ok(releaseMeasureIndex < releaseSizeValidationIndex);
  assert.ok(releaseSizeValidationIndex < releaseAssembleIndex);
  assert.ok(releaseAssembleIndex < releaseUploadIndex);
  assert.ok(releaseUploadIndex < releaseDownloadIndex);
  assert.ok(releaseDownloadIndex < releasePublishIndex);
  const releaseMeasureStep = requiredWorkflowStep(
    releaseSteps,
    'Measure exact installed size',
  );
  assert.equal(releaseMeasureStep.blockRun, false);
  assert.equal(releaseMeasureStep.script, installedSizeCommand);
  const releaseSizeValidationStep = requiredWorkflowStep(
    releaseSteps,
    'Verify exact installed size and packaging budgets',
  );
  assert.doesNotMatch(
    releaseSizeValidationStep.script ?? '',
    /measure-release-size/u,
  );
  assert.match(
    releaseSizeValidationStep.script ?? '',
    /capture-runtime:size-regression-check/u,
  );
  assert.match(
    releaseSizeValidationStep.script ?? '',
    /runtime-size-report\.json[\s\S]*Get-FileHash[\s\S]*runtime-size-report\.json.*\.sha256/u,
  );
  const candidateAssemblyScript =
    requiredWorkflowStep(releaseSteps, 'Assemble release candidate').script ??
    '';
  assert.match(
    candidateAssemblyScript,
    /Copy-Item packages\/capture-runtime\/dist\/release\/\* -Destination \$runtime/u,
  );
  assert.match(
    candidateAssemblyScript,
    /Capture\.Workbench_\$\(\$Matches\.version\)_x64-setup\.exe/u,
  );
  assert.match(
    candidateAssemblyScript,
    /Canonical release installer name is not GitHub-stable/u,
  );
  assert.match(
    candidateAssemblyScript,
    /Copy-Item -LiteralPath \$installers\[0\]\.FullName -Destination \$stagedInstaller/u,
  );
  assert.match(
    candidateAssemblyScript,
    /Canonical staged installer bytes differ from the Tauri-generated installer/u,
  );
  assert.match(
    candidateAssemblyScript,
    /path = "desktop\/\$canonicalInstallerName"[\s\S]*fileName = \$canonicalInstallerName/u,
  );
  assert.match(
    candidateAssemblyScript,
    /runtime-size-report\.json[\s\S]*Get-FileHash[\s\S]*runtime-size-report\.json.*\.sha256/u,
  );
  const releaseUploadStep = requiredWorkflowStep(
    releaseSteps,
    'Upload release candidate',
  );
  const releaseDownloadStep = requiredWorkflowStep(
    releaseSteps,
    'Download release candidate',
  );
  for (const candidateTransferStep of [
    releaseUploadStep,
    releaseDownloadStep,
  ]) {
    assert.match(
      candidateTransferStep.source,
      /name:\s*capture-candidate-\$\{\{ github\.ref_name \}\}/u,
    );
  }
  const releasePublishStep = requiredWorkflowStep(
    releaseSteps,
    'Publish runtime first, then the exact Capture Workbench package idempotently',
  );
  assert.match(
    releasePublishStep.script ?? '',
    /--runtime-dir publication\/runtime/u,
  );
  assert.match(
    releasePublishStep.script ?? '',
    /--installer \$installers\[0\]\.FullName/u,
  );

  for (const [workflowName, steps] of [
    ['CI', ciSteps],
    ['Release', releaseSteps],
  ] as const) {
    const nativeBlockSteps = steps.filter(
      (step) =>
        step.shell === 'pwsh' &&
        step.blockRun &&
        step.script !== undefined &&
        nativeCommandLines(step.script).length > 0,
    );
    assert.ok(
      nativeBlockSteps.length > 0,
      `${workflowName} must retain native PowerShell block coverage.`,
    );
    for (const step of nativeBlockSteps) {
      assert.match(
        step.script ?? '',
        /^\s*\$ErrorActionPreference = 'Stop'\s*\r?\n\s*\$PSNativeCommandUseErrorActionPreference = \$true/mu,
        `${workflowName} step ${step.name} must fail fast on native errors.`,
      );
    }
  }

  for (const ancestryStep of [
    requiredWorkflowStep(releaseSteps, 'Verify tag commit belongs to main'),
  ]) {
    assertNativeErrorPreferenceWindow(
      ancestryStep.script ?? '',
      /^git merge-base --is-ancestor "\$env:GITHUB_SHA" refs\/remotes\/origin\/main$/u,
      '$ancestorExitCode = $LASTEXITCODE',
      'if ($ancestorExitCode -ne 0) {',
    );
  }
  const project = JSON.parse(runtimeProject);
  const bundleSizeReportCommand =
    project.targets['bundle-size-report'].options.command;
  assert.match(
    bundleSizeReportCommand,
    /--executable dist\/release\/capture-runtime-x86_64-pc-windows-msvc\.exe/u,
  );
  assert.doesNotMatch(
    bundleSizeReportCommand,
    /--executable dist\/executable\/capture-runtime\.exe/u,
  );
  assert.equal(project.targets['production-preflight'], undefined);
  assert.doesNotMatch(
    JSON.stringify(project.targets['build-release-artifacts'].dependsOn),
    /production-preflight/u,
  );
  assert.equal(
    project.targets['generate-production-schema'].dependsOn,
    undefined,
  );
  assert.deepEqual(project.targets['build-production-executable'].dependsOn, [
    'generate-release-engine-catalog',
  ]);
  assert.deepEqual(project.targets['build-release-artifacts'].dependsOn, [
    'build-production-executable',
    'generate-production-schema',
    'verify-worker-boundaries',
  ]);
  assert.deepEqual(
    project.targets['generate-release-engine-catalog'].dependsOn,
    ['build-ocr-worker', 'build-whisper-worker', 'validate-model-source-lock'],
  );
  assert.deepEqual(
    project.targets['verify-release-model-candidate'].dependsOn,
    ['generate-release-engine-catalog'],
  );
  assert.deepEqual(project.targets['build-ocr-worker'].dependsOn, [
    'verify-production-environment',
  ]);
  assert.deepEqual(project.targets['build-whisper-worker'].dependsOn, [
    'verify-production-environment',
  ]);
  assert.equal(
    project.targets['validate-model-source-lock'].dependsOn,
    undefined,
  );
  assert.equal(
    project.targets['classify-release-model-mode'].options.command,
    'uv run --python 3.12 python scripts/model_source_lock.py classify --output dist/metadata/release-model-mode.json',
  );
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
  assert.match(executableBuilder, /capture-runtime\.spec/u);
  assert.match(executableBuilder, /CAPTURE_ENGINE_CATALOG_BUILD_PATH/u);
  assert.match(
    executableBuilder,
    /add_argument\("--catalog", type=Path, required=True\)/u,
  );
  assert.doesNotMatch(
    executableBuilder,
    /root \/ "dist" \/ "catalog" \/ "capture-engine-catalog\.json"/u,
  );
  assert.match(
    project.targets['build-core-executable'].options.command,
    /--catalog src\/capture_runtime\/assets\/engine-catalog\.json$/u,
  );
  assert.match(
    project.targets['build-production-executable'].options.command,
    /--catalog dist\/catalog\/capture-engine-catalog\.json$/u,
  );
  assert.doesNotMatch(executableBuilder, /--collect-all/u);
  assert.match(
    publisher,
    /preflightCandidate[\s\S]*assertRemoteAssetNames[\s\S]*ensureDraftAssets[\s\S]*publishPackage/u,
  );
});
