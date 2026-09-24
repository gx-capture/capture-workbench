import { createHash } from 'node:crypto';
import {
  lstat,
  readdir,
  readFile,
  realpath,
} from 'node:fs/promises';
import { resolve } from 'node:path';

export const RUNTIME_IDENTITY_MODES = Object.freeze([
  'local-probe',
  'release',
] as const);

export type RuntimeIdentityMode = (typeof RUNTIME_IDENTITY_MODES)[number];

export type RuntimeProbeIdentity = {
  readonly runtimeExecutableSha256: string;
  readonly ocrWorkerSha256?: string;
};

export type RuntimeIdentityObservation = {
  readonly apiVersion: unknown;
  readonly ocrSchemaVersion: unknown;
  readonly contractSha256: unknown;
  readonly loadedRuntimeSha256: unknown;
  readonly loadedOcrWorkerSha256?: unknown;
  readonly runtimeVersion?: unknown;
};

export type RuntimeIdentitySoftMetadata = {
  readonly runtimeVersion?: unknown;
  readonly expectedRuntimeVersion?: unknown;
  readonly desktopHash?: unknown;
  readonly expectedDesktopHash?: unknown;
  readonly allAssetInventoryMatches?: boolean;
  readonly directUrl?: unknown;
  readonly registryPure?: boolean;
  readonly frozenLockPure?: boolean;
};

export type RuntimeReleaseIdentityGates = {
  readonly allArtifactManifestMatches: boolean;
  readonly frozenLocksMatch: boolean;
  readonly downloadBackBytesMatch: boolean;
  readonly directUrl?: unknown;
};

export type RuntimePackageIdentityInput = {
  /** Deliberately unknown so an unrecognised mode cannot be coerced. */
  readonly mode: unknown;
  readonly packageRoot: string;
  readonly runtimeExecutablePath: string;
  readonly ocrWorkerArchivePath?: string;
  readonly expectedContractSha256: string;
  readonly expectedRuntimeVersion?: string;
  readonly expectedRuntimeSha256?: string;
  readonly probe: RuntimeProbeIdentity;
  readonly observed: RuntimeIdentityObservation;
  readonly sourceTreeRoots?: readonly string[];
  readonly soft?: RuntimeIdentitySoftMetadata;
  readonly release?: RuntimeReleaseIdentityGates;
};

export type RuntimeIdentityCheck = 'match' | 'drift' | 'not-recorded';

export type RuntimePackageIdentityReport = {
  readonly mode: RuntimeIdentityMode;
  readonly hardGates: {
    readonly apiVersion: '2.0';
    readonly ocrSchemaVersion: '3';
    readonly contractSha256: string;
    readonly archiveBoundary: 'verified';
    readonly runtimeExecutableSha256: 'verified';
    readonly ocrWorkerSha256: 'verified' | 'not-applicable';
  };
  readonly soft: {
    readonly runtimeVersion: RuntimeIdentityCheck;
    readonly desktopHash: RuntimeIdentityCheck;
    readonly allAssetInventory: RuntimeIdentityCheck;
    readonly directUrl: 'present' | 'absent';
    readonly registryPurity: RuntimeIdentityCheck;
    readonly frozenLockPurity: RuntimeIdentityCheck;
  };
};

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (!isDigest(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function isSemver(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
  );
}

/** Parse the evidence mode without a permissive/default branch. */
export function parseRuntimeIdentityMode(value: unknown): RuntimeIdentityMode {
  if (value === 'local-probe' || value === 'release') return value;
  throw new Error('Runtime identity mode must be local-probe or release.');
}

function normalizedPath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+/gu, '/').replace(/\/$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathIsWithin(path: string, root: string): boolean {
  const child = normalizedPath(path);
  const parent = normalizedPath(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function assertContained(path: string, root: string, label: string): void {
  if (!pathIsWithin(path, root)) {
    throw new Error(`${label} must stay inside the packaged archive boundary.`);
  }
}

async function assertNoReparsePoint(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata) throw new Error(`${label} is missing from the package.`);
  if (metadata.isSymbolicLink()) {
    throw new Error(
      'Package identity rejects a symlink or junction in the packaged archive.',
    );
  }
}

async function walkRegularArchive(
  root: string,
  canonicalRoot: string,
): Promise<void> {
  await assertNoReparsePoint(root, 'Packaged archive root');
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) {
    throw new Error('Packaged archive boundary must be a directory.');
  }
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      await assertNoReparsePoint(child, 'Packaged archive entry');
      const canonicalChild = normalizedPath(await realpath(child));
      if (!pathIsWithin(canonicalChild, canonicalRoot)) {
        throw new Error(
          'Packaged archive entry must stay inside the canonical archive boundary.',
        );
      }
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (!entry.isFile()) {
        throw new Error(
          'Packaged archive boundary contains a non-regular entry.',
        );
      }
    }
  }
}

async function assertArchiveBoundary(
  input: RuntimePackageIdentityInput,
): Promise<void> {
  const packageRoot = resolve(input.packageRoot);
  const canonicalRoot = normalizedPath(await realpath(packageRoot));
  await walkRegularArchive(packageRoot, canonicalRoot);
  const paths = [
    ['Runtime executable', input.runtimeExecutablePath] as const,
    ...(input.ocrWorkerArchivePath
      ? ([['OCR worker archive', input.ocrWorkerArchivePath]] as const)
      : []),
  ];
  for (const [label, path] of paths) {
    await assertNoReparsePoint(path, label);
    const canonicalPath = normalizedPath(await realpath(path));
    assertContained(canonicalPath, canonicalRoot, label);
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
  }
  for (const sourceRoot of input.sourceTreeRoots ?? []) {
    const canonicalSourceRoot = normalizedPath(
      await realpath(sourceRoot).catch(() => resolve(sourceRoot)),
    );
    if (pathIsWithin(canonicalRoot, canonicalSourceRoot)) {
      throw new Error('Package identity rejects a source-tree import.');
    }
    for (const [label, path] of paths) {
      const canonicalPath = normalizedPath(await realpath(path));
      if (pathIsWithin(canonicalPath, canonicalSourceRoot)) {
        throw new Error(
          `Package identity rejects a source-tree import (${label}).`,
        );
      }
    }
  }
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function softCheck(value: unknown, expected: unknown): RuntimeIdentityCheck {
  if (value === undefined || expected === undefined) return 'not-recorded';
  return value === expected ? 'match' : 'drift';
}

function booleanSoftCheck(value: boolean | undefined): RuntimeIdentityCheck {
  if (value === undefined) return 'not-recorded';
  return value ? 'match' : 'drift';
}

function directUrlStatus(value: unknown): 'present' | 'absent' {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (typeof value === 'string' && !value.trim())
  )
    ? 'absent'
    : 'present';
}

function assertObservation(input: RuntimePackageIdentityInput): void {
  if (input.observed.apiVersion !== '2.0') {
    throw new Error('Runtime identity requires API version 2.0.');
  }
  if (input.observed.ocrSchemaVersion !== '3') {
    throw new Error('Runtime identity requires OCR schema version 3.');
  }
  if (input.observed.contractSha256 !== input.expectedContractSha256) {
    throw new Error('Runtime identity contract hash does not match the probe.');
  }
  assertDigest(input.expectedContractSha256, 'Expected contract SHA-256');
  assertDigest(
    input.probe.runtimeExecutableSha256,
    'Probed runtime executable SHA-256',
  );
  if (input.probe.ocrWorkerSha256 !== undefined) {
    assertDigest(input.probe.ocrWorkerSha256, 'Probed OCR worker SHA-256');
  }
  if (input.observed.loadedRuntimeSha256 !== input.probe.runtimeExecutableSha256) {
    throw new Error('Loaded runtime executable SHA does not match the probe.');
  }
}

function assertReleaseGates(input: RuntimePackageIdentityInput, runtimeSha256: string): void {
  const expectedVersion = input.expectedRuntimeVersion;
  if (!isSemver(expectedVersion)) {
    throw new Error('Release identity requires an exact runtime version.');
  }
  if (input.observed.runtimeVersion !== expectedVersion) {
    throw new Error('Release identity requires the exact runtime version.');
  }
  assertDigest(input.expectedRuntimeSha256, 'Expected release runtime SHA-256');
  if (runtimeSha256 !== input.expectedRuntimeSha256) {
    throw new Error('Release identity requires the exact runtime executable SHA.');
  }
  const gates = input.release;
  if (
    !gates?.allArtifactManifestMatches ||
    !gates.frozenLocksMatch ||
    !gates.downloadBackBytesMatch
  ) {
    throw new Error('Release identity requires exact release gates.');
  }
  if (
    directUrlStatus(gates.directUrl) === 'present' ||
    directUrlStatus(input.soft?.directUrl) === 'present'
  ) {
    throw new Error('Release identity rejects local direct_url metadata.');
  }
}

/**
 * Verify a package at the one evidence seam used by local and release E2E.
 * Local probes retain the hard compatibility/loaded-byte checks while making
 * incidental rebuild and package-manager metadata visible as deferred facts.
 */
export async function verifyRuntimePackageIdentity(
  input: RuntimePackageIdentityInput,
): Promise<RuntimePackageIdentityReport> {
  const mode = parseRuntimeIdentityMode(input.mode);
  await assertArchiveBoundary(input);
  assertObservation(input);
  const runtimeSha256 = await fileSha256(input.runtimeExecutablePath);
  if (runtimeSha256 !== input.probe.runtimeExecutableSha256) {
    throw new Error('Runtime executable SHA does not match the probe.');
  }

  let ocrWorkerSha256: 'verified' | 'not-applicable' = 'not-applicable';
  if (input.ocrWorkerArchivePath !== undefined) {
    if (input.probe.ocrWorkerSha256 === undefined) {
      throw new Error('OCR worker probe SHA-256 is required for this package.');
    }
    const workerSha256 = await fileSha256(input.ocrWorkerArchivePath);
    if (workerSha256 !== input.probe.ocrWorkerSha256) {
      throw new Error('OCR worker SHA does not match the probe.');
    }
    if (input.observed.loadedOcrWorkerSha256 !== workerSha256) {
      throw new Error('Loaded OCR worker SHA does not match the probe.');
    }
    ocrWorkerSha256 = 'verified';
  } else if (mode === 'local-probe') {
    throw new Error('Local-probe identity requires an OCR worker archive.');
  }

  if (mode === 'release') assertReleaseGates(input, runtimeSha256);

  const soft = input.soft;
  return {
    mode,
    hardGates: {
      apiVersion: '2.0',
      ocrSchemaVersion: '3',
      contractSha256: input.expectedContractSha256,
      archiveBoundary: 'verified',
      runtimeExecutableSha256: 'verified',
      ocrWorkerSha256,
    },
    soft: {
      runtimeVersion: softCheck(
        soft?.runtimeVersion ?? input.observed.runtimeVersion,
        soft?.expectedRuntimeVersion ?? input.expectedRuntimeVersion,
      ),
      desktopHash: softCheck(soft?.desktopHash, soft?.expectedDesktopHash),
      allAssetInventory: booleanSoftCheck(soft?.allAssetInventoryMatches),
      directUrl: directUrlStatus(soft?.directUrl),
      registryPurity: booleanSoftCheck(soft?.registryPure),
      frozenLockPurity: booleanSoftCheck(soft?.frozenLockPure),
    },
  };
}
