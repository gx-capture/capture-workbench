import { spawn } from 'node:child_process';
import { lstat } from 'node:fs';
import { readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { sha256File } from './stage-runtime.ts';
import { assertStrictDescendant } from './contracts/installed.ts';

export function createInstalledSmokeLifecycle({
  workspaceRoot,
  smokeRoot,
  runRoot,
  nsisDirectory,
  childEnvironmentAllowlist,
  terminateTrackedProcessTree,
}) {
async function prepareSmokeDirectories() {
  await mkdir(smokeRoot, { recursive: true });
  const [workspaceRealPath, smokeRealPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(smokeRoot),
  ]);
  assertStrictDescendant(
    workspaceRealPath,
    smokeRealPath,
    'Installed smoke output directory',
  );
}

async function safeRemoveTree(root, target) {
  const safeTarget = assertStrictDescendant(
    root,
    target,
    'Recursive removal target',
  );
  let metadata;
  try {
    metadata = await lstat(safeTarget);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      'Recursive removal target must be an owned real directory.',
    );
  }
  await rm(safeTarget, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}

async function findDeterministicInstaller() {
  const [workspaceRealPath, directoryRealPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(nsisDirectory),
  ]);
  assertStrictDescendant(
    workspaceRealPath,
    directoryRealPath,
    'NSIS artifact directory',
  );
  const entries = await readdir(directoryRealPath, { withFileTypes: true });
  const installers = entries.filter(
    (entry) => entry.isFile() && /_x64-setup\.exe$/iu.test(entry.name),
  );
  if (installers.length !== 1) {
    throw new Error(
      `Expected exactly one deterministic x64 NSIS installer, found ${installers.length}.`,
    );
  }
  const path = join(directoryRealPath, installers[0].name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Deterministic NSIS installer must be a regular file.');
  }
  const actualPath = await realpath(path);
  if (dirname(actualPath).toLowerCase() !== directoryRealPath.toLowerCase()) {
    throw new Error(
      'Deterministic NSIS installer escaped its artifact directory.',
    );
  }
  return {
    path: actualPath,
    fileName: basename(actualPath),
    bytes: metadata.size,
    sha256: await sha256File(actualPath),
  };
}

async function assertOwnedRegularFile(root, candidate, label) {
  const safeCandidate = assertStrictDescendant(root, candidate, label);
  const metadata = await lstat(safeCandidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  const actual = await realpath(safeCandidate);
  assertStrictDescendant(root, actual, label);
  return actual;
}

async function runCheckedExecutable(
  path,
  arguments_,
  label,
  environment,
  timeout,
) {
  const child = spawn(path, arguments_, {
    env: environment,
    stdio: 'ignore',
    windowsHide: true,
  });
  const completion = new Promise((resolveCompletion) => {
    child.once('error', (error) => resolveCompletion({ kind: 'error', error }));
    child.once('exit', (code, signal) =>
      resolveCompletion({ kind: 'exit', code, signal }),
    );
  });
  let timeoutHandle;
  const timedOut = new Promise((resolveTimeout) => {
    timeoutHandle = globalThis.setTimeout(
      () => resolveTimeout({ kind: 'timeout' }),
      timeout,
    );
    timeoutHandle.unref?.();
  });
  const outcome = await Promise.race([completion, timedOut]);
  globalThis.clearTimeout(timeoutHandle);

  if (outcome.kind === 'timeout') {
    await terminateTrackedProcessTree(child, label);
    await completion;
    throw new Error(`${label} timed out after ${timeout} ms.`);
  }
  if (outcome.kind === 'error') {
    throw new Error(`${label} could not run: ${outcome.error.message}`);
  }
  if (outcome.code !== 0) {
    throw new Error(
      `${label} exited with status ${String(outcome.code)}${outcome.signal ? ` (${outcome.signal})` : ''}.`,
    );
  }
}
  return {
    prepareSmokeDirectories,
    safeRemoveTree,
    findDeterministicInstaller,
    assertOwnedRegularFile,
    runCheckedExecutable,
  };
}
