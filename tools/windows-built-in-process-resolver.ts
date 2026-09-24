import { lstat as lstatFs, realpath as realpathFs } from 'node:fs/promises';
import { win32 } from 'node:path';

/**
 * Filesystem metadata required to verify a Windows built-in executable.
 * Callers cannot provide an executable path; only the trusted OS root is
 * read from the environment.
 */
export interface WindowsBuiltInProcessFileStat {
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly isReparsePoint?: () => boolean;
}

export interface WindowsBuiltInProcessFileAdapter {
  readonly lstat: (path: string) => Promise<WindowsBuiltInProcessFileStat>;
  readonly realpath: (path: string) => Promise<string>;
}

export const WINDOWS_BUILT_IN_POWERSHELL_SEGMENTS = [
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
] as const;

const defaultFiles: WindowsBuiltInProcessFileAdapter = {
  lstat: async (path) => lstatFs(path),
  realpath: async (path) => realpathFs(path),
};

function environmentEntries(
  environment: Readonly<Record<string, string | undefined>>,
): unknown[] {
  const names = new Set(['SYSTEMROOT', 'WINDIR']);
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        names.has(name.toUpperCase()) && typeof value === 'string',
    )
    .map(([, value]) => value);
}

function safeAbsoluteWindowsPath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\0\r\n]/u.test(value) ||
    !win32.isAbsolute(value)
  ) {
    return undefined;
  }
  return value;
}

function normalizedWindowsPath(value: string): string {
  return win32
    .normalize(value)
    .replace(/[\\/]+/gu, '/')
    .replace(/\/$/u, '')
    .toLowerCase();
}

function isStrictWindowsDescendant(path: string, root: string): boolean {
  const child = normalizedWindowsPath(path);
  const parent = normalizedWindowsPath(root);
  return child.length > parent.length && child.startsWith(`${parent}/`);
}

function isUnsafeProbeStat(
  metadata: WindowsBuiltInProcessFileStat,
): boolean {
  return metadata.isSymbolicLink() || metadata.isReparsePoint?.() === true;
}

interface VerifiedProbeRoot {
  readonly canonical: string;
}

async function verifyProbeRoot(
  configuredRoot: unknown,
  files: WindowsBuiltInProcessFileAdapter,
): Promise<VerifiedProbeRoot | undefined> {
  const absolute = safeAbsoluteWindowsPath(configuredRoot);
  if (!absolute) return undefined;
  try {
    const metadata = await files.lstat(absolute);
    if (!metadata.isDirectory() || isUnsafeProbeStat(metadata)) {
      return undefined;
    }
    const canonical = safeAbsoluteWindowsPath(await files.realpath(absolute));
    if (
      !canonical ||
      normalizedWindowsPath(canonical) !== normalizedWindowsPath(absolute)
    ) {
      return undefined;
    }
    return { canonical };
  } catch {
    return undefined;
  }
}

async function verifyProbeExecutable(
  candidate: string,
  root: VerifiedProbeRoot,
  files: WindowsBuiltInProcessFileAdapter,
): Promise<string | undefined> {
  const absolute = safeAbsoluteWindowsPath(candidate);
  if (!absolute || !isStrictWindowsDescendant(absolute, root.canonical)) {
    return undefined;
  }
  const relative = win32.relative(root.canonical, absolute);
  const segments = relative.split(/[\\/]+/u).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    return undefined;
  }
  try {
    for (let index = 0; index < segments.length; index += 1) {
      const path = win32.join(root.canonical, ...segments.slice(0, index + 1));
      const metadata = await files.lstat(path);
      if (
        isUnsafeProbeStat(metadata) ||
        (index < segments.length - 1
          ? !metadata.isDirectory()
          : !metadata.isFile())
      ) {
        return undefined;
      }
      const canonicalPath = safeAbsoluteWindowsPath(await files.realpath(path));
      if (
        !canonicalPath ||
        !isStrictWindowsDescendant(canonicalPath, root.canonical) ||
        normalizedWindowsPath(canonicalPath) !== normalizedWindowsPath(path)
      ) {
        return undefined;
      }
    }
    const canonical = safeAbsoluteWindowsPath(await files.realpath(absolute));
    if (
      !canonical ||
      !isStrictWindowsDescendant(canonical, root.canonical) ||
      normalizedWindowsPath(canonical) !== normalizedWindowsPath(absolute)
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

/**
 * Resolves Windows PowerShell without consulting PATH or user-controlled
 * executable overrides. Every filesystem failure is intentionally collapsed
 * to undefined so caller-facing acceptance evidence cannot contain paths.
 */
export async function resolveWindowsBuiltInPowerShell(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  files: Partial<WindowsBuiltInProcessFileAdapter> = {},
): Promise<string | undefined> {
  const fileAdapter: WindowsBuiltInProcessFileAdapter = {
    ...defaultFiles,
    ...files,
  };
  const configuredRoots = environmentEntries(environment);
  if (configuredRoots.length === 0) return undefined;
  const roots: VerifiedProbeRoot[] = [];
  for (const configuredRoot of configuredRoots) {
    const root = await verifyProbeRoot(configuredRoot, fileAdapter);
    if (!root) return undefined;
    roots.push(root);
  }
  const canonicalRoots = new Set(
    roots.map(({ canonical }) => normalizedWindowsPath(canonical)),
  );
  if (canonicalRoots.size !== 1) return undefined;
  const firstRoot = roots[0];
  if (!firstRoot) return undefined;
  return verifyProbeExecutable(
    win32.join(firstRoot.canonical, ...WINDOWS_BUILT_IN_POWERSHELL_SEGMENTS),
    firstRoot,
    fileAdapter,
  );
}
