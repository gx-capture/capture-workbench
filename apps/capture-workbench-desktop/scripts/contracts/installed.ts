import { isAbsolute, relative, resolve } from 'node:path';

import {
  CHILD_ENVIRONMENT_ALLOWLIST,
} from '../constants/installed.ts';
import { assertRedactedEvidence } from '../package-qa.ts';

const childEnvironmentAllowlist = CHILD_ENVIRONMENT_ALLOWLIST;

export function assertStrictDescendant(root, candidate, label = 'Path') {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath) ||
    resolvedCandidate.includes('\0') ||
    /[\r\n]/u.test(resolvedCandidate)
  ) {
    throw new Error(
      `${label} must be a strict descendant of the installed-smoke root.`,
    );
  }
  return resolvedCandidate;
}

export function installerArguments(root, target) {
  const safeTarget = assertStrictDescendant(root, target, 'Install directory');
  // Tauri's /NS switch suppresses Start Menu/Desktop shortcut creation, keeping
  // this verification install inside the explicitly owned filesystem/registry scope.
  return ['/S', '/NS', `/D=${safeTarget}`];
}

export function uninstallerArguments(root, target) {
  assertStrictDescendant(root, target, 'Uninstall directory');
  return ['/S'];
}

export function assertRegistryOwnership(value, expectedDirectory, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} does not contain an owned install path.`);
  }
  const candidate = stripOuterQuotes(value);
  if (!isAbsolute(candidate)) {
    throw new Error(`${label} does not contain an absolute install path.`);
  }
  if (
    resolve(candidate).toLowerCase() !==
    resolve(expectedDirectory).toLowerCase()
  ) {
    throw new Error(`${label} no longer belongs to the installed-smoke run.`);
  }
}

export function assertTaskkillResult(result, stillOwned) {
  if (result.error) {
    throw new Error(
      `Owned process cleanup could not run: ${result.error.message}`,
    );
  }
  if (result.status !== 0 && stillOwned) {
    throw new Error(
      `Owned process cleanup exited with status ${String(result.status)} while the PID remained owned.`,
    );
  }
}

export function assertInstallationCleanupAllowed(ownedProcessesStopped) {
  if (ownedProcessesStopped !== true) {
    throw new Error(
      'Refusing to uninstall or remove installed-smoke data without proving all owned processes stopped.',
    );
  }
}

export function buildInstalledAppEnvironment(source, directories, cdpPort) {
  if (!Number.isSafeInteger(cdpPort) || cdpPort < 0 || cdpPort > 65_535) {
    throw new Error('WebView2 CDP port must be 0 (dynamic) or from 1 through 65535.');
  }
  const environment = {};
  for (const allowedName of childEnvironmentAllowlist) {
    const sourceEntry = Object.entries(source).find(
      ([name, value]) =>
        name.toUpperCase() === allowedName &&
        typeof value === 'string' &&
        value.length > 0,
    );
    if (sourceEntry) environment[allowedName] = sourceEntry[1];
  }

  const isolatedRoot = resolve(directories.root);
  const appData = assertStrictDescendant(
    isolatedRoot,
    directories.appData,
    'APPDATA directory',
  );
  const localAppData = assertStrictDescendant(
    isolatedRoot,
    directories.localAppData,
    'LOCALAPPDATA directory',
  );
  const temporary = assertStrictDescendant(
    isolatedRoot,
    directories.temporary,
    'Temporary directory',
  );
  const webViewData = assertStrictDescendant(
    isolatedRoot,
    directories.webViewData,
    'WebView2 user-data directory',
  );
  return {
    ...environment,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} --remote-allow-origins=*`,
    WEBVIEW2_USER_DATA_FOLDER: webViewData,
  };
}

export function assertInstalledSmokeEvidence(report) {
  if (
    report?.evidenceKind !== 'deterministic-installed-tauri-smoke' ||
    report?.releaseGateSatisfied !== false ||
    report?.realEnginesExercised !== false
  ) {
    throw new Error(
      'Installed smoke evidence must remain deterministic and non-releaseable.',
    );
  }
  if (
    typeof report.disclaimer !== 'string' ||
    !/deterministic/iu.test(report.disclaimer) ||
    !/does not/iu.test(report.disclaimer)
  ) {
    throw new Error(
      'Installed smoke evidence requires an explicit deterministic disclaimer.',
    );
  }
  const serialized = JSON.stringify(report);
  if (/[A-Za-z]:[\\/]/u.test(serialized)) {
    throw new Error(
      'Installed smoke evidence must not contain absolute Windows paths.',
    );
  }
  assertRedactedEvidence(report);
}
function stripOuterQuotes(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}
