import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createInstalledProcessCleanup } from './installed-process-cleanup.ts';
import {
  installedSmokeDiagnosticRedactionMarker,
  nestedErrorMessages,
} from './installed-deterministic-smoke.ts';

function observe(observable) {
  return new Promise((resolvePromise, rejectPromise) => {
    let value;
    observable.subscribe({
      next: (nextValue) => {
        value = nextValue;
      },
      error: rejectPromise,
      complete: () => resolvePromise(value),
    });
  });
}

async function observeUntil(observableFactory, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await observe(observableFactory());
    if (predicate(value)) return value;
    if (Date.now() >= deadline) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  } while (Date.now() < deadline);
  throw new Error('Owned process did not become observable before the test deadline.');
}

function observerResult(stdout) {
  return {
    error: undefined,
    signal: null,
    status: 0,
    stderr: '',
    stdout,
  };
}

function timeoutResult() {
  return {
    error: Object.assign(
      new Error(
        'spawnSync C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe ETIMEDOUT',
      ),
      { code: 'ETIMEDOUT' },
    ),
    signal: 'SIGTERM',
    status: null,
    stderr: '',
    stdout: '',
  };
}

function cleanupHarness({ observerResults, taskkillResult, register = true }) {
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), 'capture-installed-process-unit-'),
  );
  const smokeRoot = join(fixtureRoot, 'installed-smoke');
  const ownedRoot = join(smokeRoot, 'run', 'install');
  mkdirSync(ownedRoot, { recursive: true });
  const calls = [];
  const cleanup = createInstalledProcessCleanup({
    smokeRoot,
    workspaceRoot: fixtureRoot,
    baseChildEnvironment: () => ({}),
    windowsSystemExecutable: (...segments) =>
      join(process.env['SYSTEMROOT'] ?? 'C:\\Windows', ...segments),
    spawnSyncProcess: (command, arguments_, options) => {
      calls.push({ command, arguments: arguments_, options });
      if (/taskkill\.exe$/iu.test(command)) {
        return (
          taskkillResult ?? {
            error: undefined,
            signal: null,
            status: 0,
            stderr: '',
            stdout: '',
          }
        );
      }
      const result = observerResults.shift();
      assert.ok(result, 'Unexpected owned-process observer call.');
      return result;
    },
  });
  if (register) cleanup.registerPrivateProcessRoots([ownedRoot]);
  return {
    calls,
    cleanup,
    dispose: () => rmSync(fixtureRoot, { force: true, recursive: true }),
    ownedRoot,
  };
}

test('owned process observer uses a bounded .NET process query and fails closed with safe diagnostics', async (t) => {
  const harness = cleanupHarness({
    observerResults: [timeoutResult(), timeoutResult()],
  });
  t.after(harness.dispose);

  await assert.rejects(
    observe(harness.cleanup.processesRunningUnder(harness.ownedRoot)),
    (error) => {
      const messages = nestedErrorMessages(error);
      assert.equal(messages.includes(installedSmokeDiagnosticRedactionMarker), false);
      assert.deepEqual(messages, [
        'Owned process observer failed (operation=query; observer=dotnet-process; attempt=2/2; timeout=true; code=ETIMEDOUT; status=none; signal=SIGTERM).',
      ]);
      assert.doesNotMatch(messages[0], /[A-Za-z]:[\\/]/u);
      return true;
    },
  );

  assert.equal(harness.calls.length, 2);
  for (const call of harness.calls) {
    const script = call.arguments.at(-1);
    assert.match(script, /GetProcessesByName/u);
    assert.match(script, /MainModule\.FileName/u);
    assert.match(script, /\.Dispose\(\)/u);
    assert.match(script, /CAPTURE_SMOKE_PROCESS_NAMES/u);
    assert.match(script, /CAPTURE_SMOKE_ALLOW_MISSING_ROOT/u);
    assert.match(script, /PathType Container/u);
    assert.doesNotMatch(script, /Get-CimInstance/u);
    assert.doesNotMatch(script, /Win32_Process/u);
    assert.doesNotMatch(script, /Get-ChildItem[\s\S]*-Recurse/u);
    assert.doesNotMatch(script, /Get-Process/u);
    assert.equal(call.options.timeout, 60_000);
  }
});

test('owned process observer does not treat empty output as an empty process set', async (t) => {
  const harness = cleanupHarness({
    observerResults: [observerResult(''), observerResult('')],
  });
  t.after(harness.dispose);

  await assert.rejects(
    observe(harness.cleanup.processesRunningUnder(harness.ownedRoot)),
    /operation=validate; observer=dotnet-process; attempt=2\/2; timeout=false; code=EMPTY_OUTPUT/u,
  );
});

test('private process roots must be empty and registered for the current run', (t) => {
  const harness = cleanupHarness({
    observerResults: [],
    register: false,
  });
  t.after(harness.dispose);

  assert.throws(
    () => harness.cleanup.processesRunningUnder(harness.ownedRoot),
    /not registered for the current installed-smoke run/u,
  );
  writeFileSync(join(harness.ownedRoot, 'pre-existing.exe'), 'not executable');
  assert.throws(
    () => harness.cleanup.registerPrivateProcessRoots([harness.ownedRoot]),
    /must be a real empty directory/u,
  );
});

test('owned process observer rejects malformed JSON', async (t) => {
  const harness = cleanupHarness({
    observerResults: [observerResult('{'), observerResult('{')],
  });
  t.after(harness.dispose);

  await assert.rejects(
    observe(harness.cleanup.processesRunningUnder(harness.ownedRoot)),
    /operation=parse; observer=dotnet-process; attempt=2\/2; timeout=false; code=INVALID_JSON/u,
  );
});

for (const [label, pid] of [
  ['invalid PID', 0],
  ['unsafe PID', Number.MAX_SAFE_INTEGER + 1],
]) {
  test(`owned process observer rejects ${label}`, async (t) => {
    const output = JSON.stringify([{ pid }]);
    const harness = cleanupHarness({
      observerResults: [observerResult(output), observerResult(output)],
    });
    t.after(harness.dispose);

    await assert.rejects(
      observe(harness.cleanup.processesRunningUnder(harness.ownedRoot)),
      /operation=validate; observer=dotnet-process; attempt=2\/2; timeout=false; code=INVALID_OUTPUT/u,
    );
  });
}

test('owned process cleanup kills observed PIDs and proves the root empty', async (t) => {
  const harness = cleanupHarness({
    observerResults: [
      observerResult('[{"pid":4312}]'),
      observerResult('[{"pid":4312}]'),
      observerResult('[{"pid":4312}]'),
      observerResult('[]'),
      observerResult('[]'),
    ],
  });
  t.after(harness.dispose);

  await observe(
    harness.cleanup.stopAndProveOwnedProcesses(undefined, harness.ownedRoot),
  );

  const taskkillCalls = harness.calls.filter((call) =>
    /taskkill\.exe$/iu.test(call.command),
  );
  assert.equal(taskkillCalls.length, 1);
  assert.deepEqual(taskkillCalls[0].arguments, [
    '/PID',
    '4312',
    '/T',
    '/F',
  ]);
});

test('owned process cleanup rejects a PID that remains after taskkill', async (t) => {
  const harness = cleanupHarness({
    observerResults: [
      observerResult('[{"pid":4312}]'),
      observerResult('[{"pid":4312}]'),
      observerResult('[{"pid":4312}]'),
      observerResult('[{"pid":4312}]'),
    ],
    taskkillResult: {
      error: undefined,
      signal: null,
      status: 128,
      stderr: '',
      stdout: '',
    },
  });
  t.after(harness.dispose);

  await assert.rejects(
    observe(
      harness.cleanup.stopAndProveOwnedProcesses(undefined, harness.ownedRoot),
    ),
    /status 128 while the PID remained owned/u,
  );
});

test(
  'residual cleanup treats a missing root as empty while registered roots stay strict',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), 'capture-installed-process-missing-root-'),
    );
    const smokeRoot = join(fixtureRoot, 'installed-smoke');
    const ownedRoot = join(smokeRoot, 'run', 'install');
    const residualRoot = join(smokeRoot, 'run', 'residual');
    await mkdir(ownedRoot, { recursive: true });

    const systemRoot =
      process.env['SYSTEMROOT'] ??
      process.env['SystemRoot'] ??
      'C:\\Windows';
    const systemExecutable = (...segments) => join(systemRoot, ...segments);
    const cleanup = createInstalledProcessCleanup({
      smokeRoot,
      workspaceRoot: fixtureRoot,
      baseChildEnvironment: (source) => source,
      windowsSystemExecutable: systemExecutable,
    });
    cleanup.registerPrivateProcessRoots([ownedRoot]);
    t.after(() =>
      rm(fixtureRoot, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    );

    await observe(cleanup.stopAndProveResidualProcessRoots([residualRoot]));
    await rm(ownedRoot, { force: true, recursive: true });
    await assert.rejects(
      observe(cleanup.processesRunningUnder(ownedRoot)),
      /Owned process executable inventory could not be read/u,
    );
  },
);

test(
  'Windows path-scoped cleanup terminates an executable under the private root only',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), 'capture-installed-process-integration-'),
    );
    const smokeRoot = join(fixtureRoot, 'installed-smoke');
    const ownedRoot = join(smokeRoot, 'run', 'install');
    const nestedOwnedRoot = join(ownedRoot, 'resources', 'binaries');
    const outsideRoot = join(fixtureRoot, 'outside');
    await mkdir(ownedRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });

    const systemRoot =
      process.env['SYSTEMROOT'] ??
      process.env['SystemRoot'] ??
      'C:\\Windows';
    const systemExecutable = (...segments) =>
      join(systemRoot, ...segments);
    const cleanup = createInstalledProcessCleanup({
      smokeRoot,
      workspaceRoot: fixtureRoot,
      baseChildEnvironment: (source) => source,
      windowsSystemExecutable: systemExecutable,
    });
    cleanup.registerPrivateProcessRoots([ownedRoot]);

    await mkdir(nestedOwnedRoot, { recursive: true });
    const ownedExecutable = join(nestedOwnedRoot, 'runtime.exe');
    const outsideExecutable = join(outsideRoot, 'runtime.exe');
    await copyFile(
      systemExecutable('System32', 'cmd.exe'),
      ownedExecutable,
    );
    await copyFile(
      systemExecutable('System32', 'cmd.exe'),
      outsideExecutable,
    );

    const commandArguments = [
      '/d',
      '/q',
      '/c',
      'ping.exe -n 60 127.0.0.1 >nul',
    ];
    const ownedChild = spawn(ownedExecutable, commandArguments, {
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    const outsideChild = spawn(outsideExecutable, commandArguments, {
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    t.after(async () => {
      for (const child of [ownedChild, outsideChild]) {
        if (child.exitCode === null && child.pid) {
          spawnSync(
            systemExecutable('System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true },
          );
        }
      }
      await rm(fixtureRoot, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
    });
    await Promise.all([once(ownedChild, 'spawn'), once(outsideChild, 'spawn')]);

    const observed = await observeUntil(
      () => cleanup.processesRunningUnder(ownedRoot),
      (processes) =>
        processes.some((process_) => process_.pid === ownedChild.pid),
    );
    assert.equal(
      observed.some((process_) => process_.pid === ownedChild.pid),
      true,
    );
    assert.equal(
      observed.some((process_) => process_.pid === outsideChild.pid),
      false,
    );

    await observe(
      cleanup.stopAndProveOwnedProcesses(ownedChild.pid, ownedRoot),
    );
    assert.deepEqual(
      await observe(cleanup.processesRunningUnder(ownedRoot)),
      [],
    );
    assert.equal(outsideChild.exitCode, null);
    assert.doesNotThrow(() => process.kill(outsideChild.pid, 0));
  },
);
