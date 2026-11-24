import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  CHILD_ENVIRONMENT_ALLOWLIST,
} from '../constants/installed.ts';
import { assertRedactedEvidence } from '../hash-qa-installer.ts';

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

const WEBVIEW2_RUNTIME_CLIENT = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

/**
 * Where an installed Evergreen WebView2 Runtime records its version (`pv`):
 * per machine on 64-bit and 32-bit Windows, and per user.
 */
export const WEBVIEW2_RUNTIME_VERSION_KEYS = [
  { scope: 'per-machine', key: `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_RUNTIME_CLIENT}` },
  { scope: 'per-machine', key: `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_RUNTIME_CLIENT}` },
  { scope: 'per-user', key: `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_RUNTIME_CLIENT}` },
] as const;

/**
 * Whether a `pv` value is the version of an installed runtime, read as CI's
 * prerequisite does (.github/actions/ensure-webview2,
 * `[version]$version -gt [version]'0.0.0.0'`): a .NET version of two to four
 * dot-separated whole numbers, each at most Int32's maximum and with any
 * number of leading zeros (`1.00000000000` is 1.0), greater than 0.0.0.0.
 * .NET counts a missing component as below 0, so `0.0` is not greater and a
 * version is greater exactly when one of its components is above 0.
 */
function isInstalledWebViewRuntimeVersion(value: string | undefined): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split('.');
  if (parts.length < 2 || parts.length > 4 || !parts.every((part) => /^[0-9]+$/u.test(part))) return false;
  // Number reads leading zeros as decimal; a component too long for Int32 reads above it.
  const components = parts.map(Number);
  return components.every((component) => component <= 2_147_483_647) && components.some((component) => component > 0);
}

/**
 * The QA installer installs a missing WebView2 Runtime silently and its
 * uninstaller leaves it behind, so an installed QA check runs the installer
 * only when the runtime is already there. A version that is missing, is not a
 * version, or is 0.0.0.0 means not installed.
 */
export function assertWebViewRuntimeInstalled(
  found: readonly { readonly scope: string; readonly version: string | undefined }[],
): { readonly scope: string; readonly version: string } {
  const installed = found.find((entry): entry is { scope: string; version: string } => isInstalledWebViewRuntimeVersion(entry.version));
  if (!installed) {
    throw new Error(
      'The WebView2 Runtime is not installed (no valid version under EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5} for this machine or user). '
      + 'The QA installer would install it and its uninstaller would leave it behind, so the check does not install. '
      + 'Install the Evergreen WebView2 Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ and run the check again.',
    );
  }
  return { scope: installed.scope, version: installed.version.trim() };
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

function allowlistedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const allowedName of childEnvironmentAllowlist) {
    const sourceEntry = Object.entries(source).find(
      ([name, value]) =>
        name.toUpperCase() === allowedName &&
        typeof value === 'string' &&
        value.length > 0,
    );
    if (sourceEntry) environment[allowedName] = sourceEntry[1] as string;
  }
  return environment;
}

/**
 * The environment of an installer, uninstaller or system tool an installed
 * check starts: only allowlisted variables, with TEMP and TMP in a directory
 * the check owns.
 */
export function installedChildEnvironment(
  source: NodeJS.ProcessEnv,
  isolatedTemp: string,
  ownedRoot: string,
): Record<string, string> {
  const environment = allowlistedEnvironment(source);
  const safeTemp = assertStrictDescendant(ownedRoot, isolatedTemp, 'Temporary directory');
  environment.TEMP = safeTemp;
  environment.TMP = safeTemp;
  return environment;
}

export function buildInstalledAppEnvironment(source, directories, cdpPort): Record<string, string> {
  if (!Number.isSafeInteger(cdpPort) || cdpPort < 0 || cdpPort > 65_535) {
    throw new Error('WebView2 CDP port must be 0 (dynamic) or from 1 through 65535.');
  }
  const environment = allowlistedEnvironment(source);

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
  const requestLog = directories.requestLog === undefined ? undefined
    : assertStrictDescendant(temporary, directories.requestLog, 'Deterministic request log');
  return {
    ...environment,
    CAPTURE_ACCEPTANCE_APP_DATA_ROOT: join(isolatedRoot, 'artifacts', 'appdata'),
    E2E_ARTIFACT_ROOT: join(isolatedRoot, 'artifacts'),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    // WebView2 documents --remote-debugging-port as the supported opt-in for
    // the CDP endpoint. Keep this value minimal: extra Chromium flags can
    // cause hosted WebView2 instances to ignore the whole environment value.
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    WEBVIEW2_USER_DATA_FOLDER: webViewData,
    ...(requestLog ? { CAPTURE_DETERMINISTIC_REQUEST_LOG: requestLog } : {}),
  };
}

export function assertInstalledSmokeEvidence(report) {
  if (
    report?.evidenceKind !== 'installed-nsis-smoke' ||
    report?.releaseGateSatisfied !== false ||
    report?.realEnginesExercised !== false
  ) {
    throw new Error(
      'Installed smoke evidence requires the installed NSIS kind and must remain non-releaseable.',
    );
  }
  if (
    report.installerSource !== 'deterministic' &&
    report.installerSource !== 'release'
  ) {
    throw new Error(
      'Installed smoke evidence requires a valid installer source.',
    );
  }
  if (
    report.installedApplication !== undefined &&
    (typeof report.installedApplication !== 'object' ||
      report.installedApplication === null ||
      'model' in report.installedApplication)
  ) {
    throw new Error(
      'Installed smoke evidence must not carry a deprecated installedApplication.model field.',
    );
  }
  if (report.captures !== undefined) {
    if (!Array.isArray(report.captures)) {
      throw new Error('Installed smoke evidence captures must be an array.');
    }
    for (const capture of report.captures) {
      if (
        typeof capture !== 'object' ||
        capture === null ||
        'targetTextVisible' in capture ||
        (capture as { recognizedTextVisible?: unknown }).recognizedTextVisible !== true
      ) {
        throw new Error(
          'Installed smoke evidence captures must report recognizedTextVisible: true without targetTextVisible.',
        );
      }
    }
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
