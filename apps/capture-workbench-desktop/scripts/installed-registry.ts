import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertRegistryOwnership,
  assertStrictDescendant,
} from './contracts/installed.ts';

export function createInstalledRegistry({
  smokeRoot,
  workspaceRoot,
  registryViews,
  productRegistryKey,
  uninstallRegistryKey,
  baseChildEnvironment,
  pathExists,
}) {
  async function waitUntil(check, timeout, message) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(100);
    }
    throw new Error(message);
  }

async function waitForInstalledDirectoryRemoval(directory) {
  await waitUntil(
    async () => !(await pathExists(directory)),
    30_000,
    'Installed NSIS uninstaller did not remove its exact install directory.',
  );
  if (await registryKeyExists(uninstallRegistryKey)) {
    throw new Error(
      'Installed NSIS uninstaller left its uninstall registry key.',
    );
  }
}

async function assertNoPreExistingInstallation() {
  const existing = [];
  for (const key of [uninstallRegistryKey, productRegistryKey]) {
    for (const view of registryViews) {
      if (await registryKeyExists(key, view)) existing.push(`${key} (${view})`);
    }
  }
  if (existing.length > 0) {
    throw new Error(
      'A pre-existing Capture Workbench Verification installation was found; refusing to modify it.',
    );
  }
}

async function assertInstalledRegistryPointsToOwnedDirectory(directory) {
  const ownedValues = [
    {
      key: uninstallRegistryKey,
      label: 'Installed NSIS uninstall registry key',
      read: (view) =>
        registryValue(uninstallRegistryKey, 'InstallLocation', view),
    },
    {
      key: productRegistryKey,
      label: 'Installed NSIS product registry key',
      read: (view) => registryDefaultValue(productRegistryKey, view),
    },
  ];
  for (const ownedValue of ownedValues) {
    let presentViews = 0;
    for (const view of registryViews) {
      if (!(await registryKeyExists(ownedValue.key, view))) continue;
      presentViews += 1;
      const value = await ownedValue.read(view);
      assertRegistryOwnership(
        value,
        directory,
        `${ownedValue.label} (${view}-bit view)`,
      );
    }
    if (presentViews === 0) {
      throw new Error(
        `${ownedValue.label} is absent; refusing destructive cleanup.`,
      );
    }
  }
}

async function removeOwnedRegistryResidue(expectedDirectory) {
  for (const key of [uninstallRegistryKey, productRegistryKey]) {
    for (const view of registryViews) {
      if (await registryKeyExists(key, view)) {
        const ownershipValue =
          key === uninstallRegistryKey
            ? await registryValue(key, 'InstallLocation', view)
            : await registryDefaultValue(key, view);
        assertRegistryOwnership(
          ownershipValue,
          expectedDirectory,
          `${key} (${view}-bit view)`,
        );
        const result = registryCommand(['delete', key, '/f', `/reg:${view}`]);
        if (result.status !== 0) {
          throw new Error('Owned NSIS registry residue could not be removed.');
        }
      }
    }
  }
  for (const key of [uninstallRegistryKey, productRegistryKey]) {
    for (const view of registryViews) {
      if (await registryKeyExists(key, view)) {
        throw new Error('Owned NSIS registry residue remained after cleanup.');
      }
    }
  }
}

async function registryKeyExists(key, view = '64') {
  const result = registryCommand(['query', key, `/reg:${view}`]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('Windows registry query failed.');
}

async function registryValue(key, name, view) {
  const result = registryCommand(['query', key, '/v', name, `/reg:${view}`]);
  if (result.status === 1) return undefined;
  if (result.status !== 0)
    throw new Error('Windows registry value query failed.');
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith(name));
  const match = line?.match(/^\s*\S+\s+REG_\S+\s+(.*?)\s*$/u);
  if (!match) throw new Error('Windows registry value response was malformed.');
  return match[1];
}

async function registryDefaultValue(key, view) {
  const result = registryCommand(['query', key, '/ve', `/reg:${view}`]);
  if (result.status === 1) return undefined;
  if (result.status !== 0)
    throw new Error('Windows registry value query failed.');
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => /\sREG_\S+\s/u.test(candidate));
  const match = line?.match(/^\s*.+?\s+REG_\S+\s+(.*?)\s*$/u);
  if (!match)
    throw new Error('Windows registry default value response was malformed.');
  return match[1];
}

function registryCommand(arguments_) {
  return spawnSync(windowsSystemExecutable('System32', 'reg.exe'), arguments_, {
    env: baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
}

function windowsSystemExecutable(...segments) {
  if (process.platform !== 'win32') {
    throw new Error('Windows system executable resolution requires Windows.');
  }
  const systemRootEntry = Object.entries(process.env).find(
    ([name, value]) =>
      (name.toUpperCase() === 'SYSTEMROOT' ||
        name.toUpperCase() === 'WINDIR') &&
      typeof value === 'string' &&
      value.length > 0,
  );
  const configuredRoot = systemRootEntry?.[1];
  if (
    !configuredRoot ||
    !isAbsolute(configuredRoot) ||
    /[\0\r\n]/u.test(configuredRoot)
  ) {
    throw new Error('Windows system root is unavailable or unsafe.');
  }
  const systemRoot = realpathSync(resolve(configuredRoot));
  const candidate = realpathSync(join(systemRoot, ...segments));
  assertStrictDescendant(systemRoot, candidate, 'Windows system executable');
  const metadata = lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Windows system executable must be a regular file.');
  }
  return candidate;
}

function stripOuterQuotes(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}
  return {
    waitForInstalledDirectoryRemoval,
    assertNoPreExistingInstallation,
    assertInstalledRegistryPointsToOwnedDirectory,
    removeOwnedRegistryResidue,
    windowsSystemExecutable,
  };
}
