import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertStrictDescendant,
  assertTaskkillResult,
} from './installed-smoke-contracts.ts';

export function createInstalledProcessCleanup({
  smokeRoot,
  workspaceRoot,
  baseChildEnvironment,
  windowsSystemExecutable,
}) {
async function terminateTrackedProcessTree(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    throw new Error(`${label} did not expose a valid owned PID.`);
  }
  const exited = new Promise((resolveExit) => {
    child.once('exit', resolveExit);
    child.once('error', resolveExit);
  });
  const result = spawnSync(
    windowsSystemExecutable('System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'],
    {
      env: baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    },
  );
  await Promise.race([exited, delay(20_000)]);
  const stillRunning = child.exitCode === null && child.signalCode === null;
  assertTaskkillResult(result, stillRunning);
  if (stillRunning) {
    throw new Error(`${label} remained active after exact PID tree cleanup.`);
  }
}



async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

async function stopAndProveOwnedProcesses(pid, ownedRoot) {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) {
    throw new Error('Owned Tauri PID is invalid.');
  }
  const before = await processesRunningUnder(ownedRoot);
  if (pid !== undefined && before.some((process_) => process_.pid === pid)) {
    await taskkillOwnedPid(pid, ownedRoot);
  }
  await delay(250);
  for (const process_ of await processesRunningUnder(ownedRoot)) {
    const stillOwned = (await processesRunningUnder(ownedRoot)).some(
      (candidate) => candidate.pid === process_.pid,
    );
    if (stillOwned) await taskkillOwnedPid(process_.pid, ownedRoot);
  }
  await waitUntil(
    async () => (await processesRunningUnder(ownedRoot)).length === 0,
    20_000,
    'Owned installed app/runtime processes remained after tree cleanup.',
  );
}

async function stopAndProveOwnedProcessRoots(ownedRoots) {
  const failures = [];
  for (const ownedRoot of ownedRoots) {
    try {
      await stopAndProveOwnedProcesses(undefined, ownedRoot);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'One or more installed-smoke process roots could not be cleaned safely.',
    );
  }
}

async function taskkillOwnedPid(pid, ownedRoot) {
  const result = spawnSync(
    windowsSystemExecutable('System32', 'taskkill.exe'),
    ['/PID', String(pid), '/T', '/F'],
    {
      env: baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    },
  );
  const stillOwned = (await processesRunningUnder(ownedRoot)).some(
    (candidate) => candidate.pid === pid,
  );
  assertTaskkillResult(result, stillOwned);
}

async function processesRunningUnder(root) {
  const safeRoot = assertStrictDescendant(
    smokeRoot,
    root,
    'Owned process root',
  );
  const script = `
$root = [IO.Path]::GetFullPath($env:CAPTURE_SMOKE_PROCESS_ROOT).TrimEnd('\\') + '\\'
$items = @(Get-CimInstance Win32_Process | ForEach-Object {
  try {
    if ($_.ExecutablePath) {
      $path = [IO.Path]::GetFullPath($_.ExecutablePath)
      if ($path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        [pscustomobject]@{ pid = [int]$_.ProcessId }
      }
    }
  } catch {}
})
ConvertTo-Json -Compress -InputObject $items
`;
  const environment = {
    ...baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
    CAPTURE_SMOKE_PROCESS_ROOT: safeRoot,
  };
  const result = spawnSync(
    windowsSystemExecutable(
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = (result.error?.message ?? result.stderr ?? '')
      .trim()
      .slice(0, 500);
    throw new Error(
      `Owned installed process query failed${detail ? `: ${detail}` : '.'}`,
    );
  }
  const output = result.stdout.trim();
  if (!output) return [];
  const value = JSON.parse(output);
  return Array.isArray(value) ? value : [value];
}

async function waitForLoopbackPortRelease(port) {
  await waitUntil(
    async () => canBindLoopbackPort(port),
    20_000,
    'WebView2 CDP port remained bound after owned process cleanup.',
  );
}

async function canBindLoopbackPort(port) {
  return new Promise((resolveAvailability) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolveAvailability(false));
    server.listen(port, '127.0.0.1', () =>
      server.close(() => resolveAvailability(true)),
    );
  });
}
  return {
    terminateTrackedProcessTree,
    stopAndProveOwnedProcesses,
    stopAndProveOwnedProcessRoots,
    processesRunningUnder,
    waitForLoopbackPortRelease,
  };
}
